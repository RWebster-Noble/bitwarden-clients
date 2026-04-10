import { LogService } from "@bitwarden/common/platform/abstractions/log.service";

import { BrowserApi } from "../../platform/browser/browser-api";

/**
 * Service for relaying passkey unlock results between the background script
 * and the popup. Uses chrome.storage.local for cross-context communication.
 */
export class PasskeyUnlockRelayService {
  private readonly STORAGE_KEY = "passkeyUnlockRelayResult";
  private storageChangeListener: ((changes: any, areaName: string) => void) | null = null;
  private resolveStorageChange: (() => void) | null = null;

  constructor(private logService: LogService) {
    this.setupStorageListener();
  }

  private setupStorageListener(): void {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      this.storageChangeListener = (changes, areaName) => {
        if (areaName === "local" && changes[this.STORAGE_KEY]) {
          this.logService.info("[PasskeyUnlockRelay] Storage change detected");
          this.resolveStorageChange?.();
        }
      };
      BrowserApi.addListener(chrome.storage.onChanged, this.storageChangeListener);
    }
  }

  /**
   * Stores the decrypted relay result in chrome.storage.local.
   * Called from the background after decrypting the PRF output.
   */
  async storeResult(result: { credentialId: string; prfOutput: ArrayBuffer }): Promise<void> {
    this.logService.info("[PasskeyUnlockRelay] Storing result in storage");

    // Convert ArrayBuffer to array for JSON serialization
    const storableResult = {
      credentialId: result.credentialId,
      prfOutput: Array.from(new Uint8Array(result.prfOutput)),
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [this.STORAGE_KEY]: storableResult });
    this.logService.info("[PasskeyUnlockRelay] Result stored successfully");
  }

  /**
   * Retrieves and clears the relay result.
   * Called once from the result popout.
   * @returns The stored result or null if none exists
   */
  async consumeResult(): Promise<{
    credentialId: string;
    prfOutput: ArrayBuffer;
  } | null> {
    this.logService.info("[PasskeyUnlockRelay] Attempting to consume result");

    // Check storage immediately first - the result may already be there
    // because the background stores it before opening the popup
    const data = await chrome.storage.local.get(this.STORAGE_KEY);
    let storedResult = data[this.STORAGE_KEY];

    if (!storedResult) {
      // Result not yet in storage, wait for it with a short timeout
      this.logService.info(
        "[PasskeyUnlockRelay] Result not in storage yet, waiting for storage change...",
      );
      try {
        await this.waitForStorageChange(5000); // 5 seconds timeout

        // Try again after receiving the event
        const dataAfterEvent = await chrome.storage.local.get(this.STORAGE_KEY);
        storedResult = dataAfterEvent[this.STORAGE_KEY];
      } catch {
        this.logService.error("[PasskeyUnlockRelay] Timeout waiting for result");
        return null;
      }
    }

    if (!storedResult) {
      this.logService.error("[PasskeyUnlockRelay] No result found in storage");
      return null;
    }

    this.logService.info("[PasskeyUnlockRelay] Result found, converting format");

    // Clear the result from storage
    await chrome.storage.local.remove(this.STORAGE_KEY);

    // Convert array back to ArrayBuffer
    const result = {
      credentialId: storedResult.credentialId,
      prfOutput: new Uint8Array(storedResult.prfOutput).buffer,
    };

    this.logService.info("[PasskeyUnlockRelay] Result consumed successfully");
    return result;
  }

  /**
   * Waits for the storage change event with a timeout.
   */
  private waitForStorageChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.resolveStorageChange = null;
        reject(new Error("Timeout"));
      }, timeoutMs);

      this.resolveStorageChange = () => {
        clearTimeout(timeoutId);
        this.resolveStorageChange = null;
        resolve();
      };
    });
  }

  /**
   * Checks if there's a pending result available.
   */
  async hasPendingResult(): Promise<boolean> {
    const data = await chrome.storage.local.get(this.STORAGE_KEY);
    const storedResult = data[this.STORAGE_KEY];

    if (!storedResult) {
      return false;
    }

    // Check if result is expired (older than 5 minutes)
    const maxAge = 5 * 60 * 1000; // 5 minutes
    if (Date.now() - storedResult.timestamp > maxAge) {
      await chrome.storage.local.remove(this.STORAGE_KEY);
      return false;
    }

    return true;
  }

  /**
   * Clears any pending result without consuming it.
   * Used for cleanup (e.g., on timeout).
   */
  async clearResult(): Promise<void> {
    this.logService.info("[PasskeyUnlockRelay] Clearing result from storage");
    await chrome.storage.local.remove(this.STORAGE_KEY);
  }
}
