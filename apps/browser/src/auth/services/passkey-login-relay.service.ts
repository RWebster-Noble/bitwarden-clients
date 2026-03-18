import { firstValueFrom, Subject } from "rxjs";
import { take, timeout } from "rxjs/operators";

import { LogService } from "@bitwarden/common/platform/abstractions/log.service";

import { BrowserApi } from "../../platform/browser/browser-api";

/**
 * Service for relaying passkey login results between the background script
 * and the popup. Uses chrome.storage.local for cross-context communication.
 */
export class PasskeyLoginRelayService {
  private readonly STORAGE_KEY = "passkeyLoginRelayResult";
  private readonly TIMEOUT_MS = 30000; // 30 seconds
  private resultReceived$ = new Subject<void>();
  private storageChangeListener: ((changes: any, areaName: string) => void) | null = null;

  constructor(private logService: LogService) {
    this.setupStorageListener();
  }

  private setupStorageListener(): void {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      this.storageChangeListener = (changes, areaName) => {
        if (areaName === "local" && changes[this.STORAGE_KEY]) {
          this.logService.info("[PasskeyLoginRelay] Storage change detected");
          this.resultReceived$.next();
        }
      };
      BrowserApi.addListener(chrome.storage.onChanged, this.storageChangeListener);
    }
  }

  destroy(): void {
    if (this.storageChangeListener && chrome.storage && chrome.storage.onChanged) {
      BrowserApi.removeListener(chrome.storage.onChanged, this.storageChangeListener);
    }
  }

  /**
   * Stores the decrypted relay result in chrome.storage.local.
   * Called from the background after decrypting the PRF output.
   */
  async storeResult(result: {
    token: string;
    assertionData: string;
    prfOutput: ArrayBuffer | null;
  }): Promise<void> {
    this.logService.info("[PasskeyLoginRelay] Storing result in storage");

    // Convert ArrayBuffer to array for JSON serialization
    const storableResult = {
      token: result.token,
      assertionData: result.assertionData,
      prfOutput: result.prfOutput ? Array.from(new Uint8Array(result.prfOutput)) : null,
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [this.STORAGE_KEY]: storableResult });
    this.logService.info("[PasskeyLoginRelay] Result stored successfully");
  }

  /**
   * Retrieves and clears the relay result.
   * Called once from the result popout.
   * @returns The stored result or null if none exists
   */
  async consumeResult(): Promise<{
    token: string;
    assertionData: string;
    prfOutput: ArrayBuffer | null;
  } | null> {
    this.logService.info("[PasskeyLoginRelay] Attempting to consume result");

    // Check storage immediately first - the result may already be there
    // because the background stores it before opening the popup
    const data = await chrome.storage.local.get(this.STORAGE_KEY);
    let storedResult = data[this.STORAGE_KEY];

    if (!storedResult) {
      // Result not yet in storage, wait for it with a short timeout
      this.logService.info(
        "[PasskeyLoginRelay] Result not in storage yet, waiting for storage change...",
      );
      try {
        await firstValueFrom(
          this.resultReceived$.pipe(
            take(1),
            timeout(5000), // 5 seconds is plenty for the background to store the result
          ),
        );

        // Try again after receiving the event
        const dataAfterEvent = await chrome.storage.local.get(this.STORAGE_KEY);
        storedResult = dataAfterEvent[this.STORAGE_KEY];
      } catch {
        this.logService.error("[PasskeyLoginRelay] Timeout waiting for result");
        return null;
      }
    }

    if (!storedResult) {
      this.logService.error("[PasskeyLoginRelay] No result found in storage");
      return null;
    }

    this.logService.info("[PasskeyLoginRelay] Result found, converting format");

    // Clear the result from storage
    await chrome.storage.local.remove(this.STORAGE_KEY);

    // Convert array back to ArrayBuffer
    const result = {
      token: storedResult.token,
      assertionData: storedResult.assertionData,
      prfOutput: storedResult.prfOutput ? new Uint8Array(storedResult.prfOutput).buffer : null,
    };

    this.logService.info("[PasskeyLoginRelay] Result consumed successfully");
    return result;
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
    this.logService.info("[PasskeyLoginRelay] Clearing result from storage");
    await chrome.storage.local.remove(this.STORAGE_KEY);
  }
}
