// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnInit, signal } from "@angular/core";
import { Router, RouterModule } from "@angular/router";
import { firstValueFrom } from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { TwoFactorAuthSecurityKeyIcon } from "@bitwarden/assets/svg";
import { UserDecryptionOptionsServiceAbstraction } from "@bitwarden/auth/common";
import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { WebAuthnLoginPrfKeyServiceAbstraction } from "@bitwarden/common/auth/abstractions/webauthn/webauthn-login-prf-key.service.abstraction";
import { EncryptService } from "@bitwarden/common/key-management/crypto/abstractions/encrypt.service";
import { EncString } from "@bitwarden/common/key-management/crypto/models/enc-string";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { ValidationService } from "@bitwarden/common/platform/abstractions/validation.service";
import { UserId } from "@bitwarden/common/types/guid";
import { UserKey } from "@bitwarden/common/types/key";
import {
  AnonLayoutWrapperDataService,
  ButtonModule,
  TypographyModule,
} from "@bitwarden/components";
import { KeyService } from "@bitwarden/key-management";

import { BrowserApi } from "../../../platform/browser/browser-api";
import {
  PasskeyRelayService,
  PasskeyUnlockRelayResult,
} from "../../services/passkey-relay.service";
import { closePasskeyResultPopout } from "../utils/auth-popout-window";

export type State = "unlocking" | "unlockFailed";

@Component({
  selector: "app-unlock-with-passkey-result",
  templateUrl: "unlock-with-passkey-result.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [CommonModule, RouterModule, JslibModule, ButtonModule, TypographyModule],
})
export class UnlockWithPasskeyResultComponent implements OnInit {
  protected readonly currentState = signal<State>("unlocking");

  protected readonly Icons = {
    TwoFactorAuthSecurityKeyIcon,
  };

  constructor(
    private readonly passkeyRelayService: PasskeyRelayService,
    private readonly webAuthnLoginPrfKeyService: WebAuthnLoginPrfKeyServiceAbstraction,
    private readonly userDecryptionOptionsService: UserDecryptionOptionsServiceAbstraction,
    private readonly accountService: AccountService,
    private readonly encryptService: EncryptService,
    private readonly router: Router,
    private readonly logService: LogService,
    private readonly validationService: ValidationService,
    private readonly i18nService: I18nService,
    private readonly keyService: KeyService,
    private readonly platformUtilsService: PlatformUtilsService,
    private readonly anonLayoutWrapperDataService: AnonLayoutWrapperDataService,
  ) {}

  ngOnInit(): void {
    // FIXME: Verify that this floating promise is intentional. If it is, add an explanatory comment and ensure there is proper error handling.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.completeUnlock();
  }

  protected retry() {
    this.currentState.set("unlocking");
    // FIXME: Verify that this floating promise is intentional. If it is, add an explanatory comment and ensure there is proper error handling.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.completeUnlock();
  }

  private async completeUnlock(): Promise<void> {
    try {
      this.logService.info("[PasskeyUnlock] Starting completeUnlock");

      // Consume the relay result
      const relayResult =
        (await this.passkeyRelayService.consumeResult()) as PasskeyUnlockRelayResult | null;

      if (relayResult && relayResult.type !== "unlock") {
        this.logService.error("[PasskeyUnlock] Unexpected result type:", relayResult.type);
        this.validationService.showError(this.i18nService.t("passkeyUnlockTimeout"));
        this.currentState.set("unlockFailed");
        this.setFailureIcon();
        return;
      }

      if (!relayResult) {
        // No result available - timeout or error
        this.logService.error("[PasskeyUnlock] No relay result available");
        this.validationService.showError(this.i18nService.t("passkeyUnlockTimeout"));
        this.currentState.set("unlockFailed");
        this.setFailureIcon();
        return;
      }

      this.logService.info("[PasskeyUnlock] Got relay result");

      const { credentialId, prfOutput } = relayResult;

      // Derive PRF key from prfOutput
      this.logService.info("[PasskeyUnlock] Deriving PRF key...");
      const prfKey = await this.webAuthnLoginPrfKeyService.createSymmetricKeyFromPrf(prfOutput);
      // Zero the raw PRF bytes immediately after use
      new Uint8Array(prfOutput).fill(0);
      this.logService.info("[PasskeyUnlock] PRF key derived successfully");

      // Get the active user
      const activeAccount = await firstValueFrom(this.accountService.activeAccount$);
      if (!activeAccount?.id) {
        throw new Error("No active account found");
      }
      const userId = activeAccount.id as UserId;

      // Get user decryption options to find the matching PRF credential
      this.logService.info("[PasskeyUnlock] Getting user decryption options...");

      const userDecryptionOptions = await firstValueFrom(
        this.userDecryptionOptionsService.userDecryptionOptionsById$(userId),
      );

      if (!userDecryptionOptions?.webAuthnPrfOptions) {
        throw new Error("No WebAuthn PRF options available for user");
      }

      const prfOption = userDecryptionOptions.webAuthnPrfOptions.find(
        (option: { credentialId: string }) => option.credentialId === credentialId,
      );

      if (!prfOption) {
        throw new Error("No matching WebAuthn PRF option found for this credential");
      }

      // Decrypt PRF encrypted private key using the PRF key
      const privateKey = await this.encryptService.unwrapDecapsulationKey(
        new EncString(prfOption.encryptedPrivateKey),
        prfKey,
      );

      // Use private key to decrypt user key
      const userKey = await this.encryptService.decapsulateKeyUnsigned(
        new EncString(prfOption.encryptedUserKey),
        privateKey,
      );

      if (!userKey) {
        throw new Error("Failed to decrypt user key from private key");
      }

      // Set the user key
      await this.keyService.setUserKey(userKey as UserKey, userId);

      this.logService.info("[PasskeyUnlock] Unlock complete");

      // Reload any other open extension windows
      this.logService.info("[PasskeyUnlock] Reloading open windows...");
      BrowserApi.reloadOpenWindows(true); // true = exclude current window

      // Close this popout
      this.logService.info("[PasskeyUnlock] Closing result popout...");
      await closePasskeyResultPopout();

      // Navigate to vault
      await this.router.navigate(["/tabs/vault"]);
    } catch (error) {
      this.logService.error("[PasskeyUnlock] Error in completeUnlock:", error);

      let errorMessage = this.i18nService.t("unexpectedError");

      if (error instanceof Error) {
        if (error.message.includes("canceled")) {
          // User canceled - close without error
          await closePasskeyResultPopout();
          return;
        }
        errorMessage = error.message;
      }

      this.validationService.showError(errorMessage);
      this.currentState.set("unlockFailed");
      this.setFailureIcon();
    }
  }

  private setDefaultIcon(): void {
    this.anonLayoutWrapperDataService.setAnonLayoutWrapperData({
      pageIcon: this.Icons.TwoFactorAuthSecurityKeyIcon,
    });
  }

  private setFailureIcon(): void {
    // For now, use the same icon but the component could show a different one
    this.setDefaultIcon();
  }
}
