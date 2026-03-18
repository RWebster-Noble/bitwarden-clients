// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnInit } from "@angular/core";
import { Router, RouterModule } from "@angular/router";
import { firstValueFrom } from "rxjs";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { TwoFactorAuthSecurityKeyIcon } from "@bitwarden/assets/svg";
import { LoginSuccessHandlerService } from "@bitwarden/auth/common";
import { WebAuthnLoginPrfKeyServiceAbstraction } from "@bitwarden/common/auth/abstractions/webauthn/webauthn-login-prf-key.service.abstraction";
import { WebAuthnLoginServiceAbstraction } from "@bitwarden/common/auth/abstractions/webauthn/webauthn-login.service.abstraction";
import { WebAuthnLoginCredentialAssertionView } from "@bitwarden/common/auth/models/view/webauthn-login/webauthn-login-credential-assertion.view";
import { WebAuthnLoginAssertionResponseRequest } from "@bitwarden/common/auth/services/webauthn-login/request/webauthn-login-assertion-response.request";
import { ClientType } from "@bitwarden/common/enums";
import { ErrorResponse } from "@bitwarden/common/models/response/error.response";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { ValidationService } from "@bitwarden/common/platform/abstractions/validation.service";
import {
  AnonLayoutWrapperDataService,
  ButtonModule,
  TypographyModule,
} from "@bitwarden/components";
import { KeyService } from "@bitwarden/key-management";

import { PasskeyLoginRelayService } from "../../services/passkey-login-relay.service";

export type State = "loggingIn" | "loginFailed";

@Component({
  selector: "app-login-with-passkey-result",
  templateUrl: "login-with-passkey-result.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [CommonModule, RouterModule, JslibModule, ButtonModule, TypographyModule],
})
export class LoginWithPasskeyResultComponent implements OnInit {
  protected readonly currentState: State = "loggingIn";

  protected readonly Icons = {
    TwoFactorAuthSecurityKeyIcon,
  };

  private readonly successRoutes: Record<ClientType, string> = {
    [ClientType.Web]: "/vault",
    [ClientType.Browser]: "/tabs/vault",
    [ClientType.Desktop]: "/vault",
    [ClientType.Cli]: "/vault",
  };

  protected get successRoute(): string {
    const clientType = this.platformUtilsService.getClientType();
    return this.successRoutes[clientType] || "/vault";
  }

  constructor(
    private readonly passkeyLoginRelayService: PasskeyLoginRelayService,
    private readonly webAuthnLoginService: WebAuthnLoginServiceAbstraction,
    private readonly webAuthnLoginPrfKeyService: WebAuthnLoginPrfKeyServiceAbstraction,
    private readonly router: Router,
    private readonly logService: LogService,
    private readonly validationService: ValidationService,
    private readonly i18nService: I18nService,
    private readonly loginSuccessHandlerService: LoginSuccessHandlerService,
    private readonly keyService: KeyService,
    private readonly platformUtilsService: PlatformUtilsService,
    private readonly anonLayoutWrapperDataService: AnonLayoutWrapperDataService,
  ) {}

  ngOnInit(): void {
    // FIXME: Verify that this floating promise is intentional. If it is, add an explanatory comment and ensure there is proper error handling.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.completeLogin();
  }

  protected retry() {
    this.currentState = "loggingIn";
    // FIXME: Verify that this floating promise is intentional. If it is, add an explanatory comment and ensure there is proper error handling.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.completeLogin();
  }

  private async completeLogin(): Promise<void> {
    try {
      this.logService.info("[PasskeyLogin] Starting completeLogin");

      // Consume the relay result
      const relayResult = await this.passkeyLoginRelayService.consumeResult();

      if (!relayResult) {
        // No result available - timeout or error
        this.logService.error("[PasskeyLogin] No relay result available");
        this.validationService.showError(this.i18nService.t("passkeyLoginTimeout"));
        this.currentState = "loginFailed";
        this.setFailureIcon();
        return;
      }

      this.logService.info(
        "[PasskeyLogin] Got relay result, token:",
        relayResult.token.substring(0, 20) + "...",
      );

      const { token, assertionData, prfOutput } = relayResult;

      this.logService.info("[PasskeyLogin] assertionData length:", assertionData.length);

      // Deserialize assertion data
      let parsedAssertion;
      try {
        parsedAssertion = JSON.parse(assertionData);
        this.logService.info(
          "[PasskeyLogin] Parsed assertion:",
          JSON.stringify({
            id: parsedAssertion.id,
            type: parsedAssertion.type,
            rawIdLength: parsedAssertion.rawId?.length,
            responseKeys: Object.keys(parsedAssertion.response || {}),
          }),
        );
      } catch (parseError) {
        this.logService.error("[PasskeyLogin] Failed to parse assertionData:", parseError);
        throw parseError;
      }

      let deviceResponse: WebAuthnLoginAssertionResponseRequest;
      try {
        deviceResponse = Object.assign(
          Object.create(WebAuthnLoginAssertionResponseRequest.prototype),
          parsedAssertion,
        ) as WebAuthnLoginAssertionResponseRequest;
        this.logService.info("[PasskeyLogin] Created deviceResponse successfully");
      } catch (assignError) {
        this.logService.error("[PasskeyLogin] Failed to assign deviceResponse:", assignError);
        throw assignError;
      }

      // Derive PRF key if prfOutput is present
      let prfKey = null;
      if (prfOutput) {
        this.logService.info("[PasskeyLogin] Deriving PRF key...");
        prfKey = await this.webAuthnLoginPrfKeyService.createSymmetricKeyFromPrf(prfOutput);
        // Zero the raw PRF bytes immediately after use
        new Uint8Array(prfOutput).fill(0);
        this.logService.info("[PasskeyLogin] PRF key derived successfully");
      } else {
        this.logService.info(
          "[PasskeyLogin] No PRF output, continuing without vault decryption key",
        );
      }

      // Create credential assertion view
      this.logService.info("[PasskeyLogin] Creating credential assertion view...");
      const assertion = new WebAuthnLoginCredentialAssertionView(token, deviceResponse, prfKey);

      // Log in using the assertion
      this.logService.info("[PasskeyLogin] Calling webAuthnLoginService.logIn...");
      const authResult = await this.webAuthnLoginService.logIn(assertion);
      this.logService.info("[PasskeyLogin] Login result:", {
        requiresTwoFactor: authResult.requiresTwoFactor,
        userId: authResult.userId,
      });

      if (authResult.requiresTwoFactor) {
        this.validationService.showError(
          this.i18nService.t("twoFactorForPasskeysNotSupportedOnClientUpdateToLogIn"),
        );
        this.currentState = "loginFailed";
        this.setFailureIcon();
        return;
      }

      // Only run loginSuccessHandlerService if webAuthn is used for vault decryption.
      this.logService.info("[PasskeyLogin] Checking user key...");
      const userKey = await firstValueFrom(this.keyService.userKey$(authResult.userId));
      this.logService.info("[PasskeyLogin] User key exists:", !!userKey);
      if (userKey) {
        this.logService.info("[PasskeyLogin] Running login success handler...");
        await this.loginSuccessHandlerService.run(authResult.userId, null);
      }

      // Navigate to vault
      this.logService.info("[PasskeyLogin] Navigating to vault...");
      await this.router.navigate([this.successRoute]);
      this.logService.info("[PasskeyLogin] Navigation complete");
    } catch (error) {
      this.logService.error("[PasskeyLogin] Error in completeLogin:", error);
      if (error instanceof ErrorResponse) {
        this.validationService.showError(this.i18nService.t("invalidPasskeyPleaseTryAgain"));
      } else if (error instanceof Error) {
        this.validationService.showError(error.message);
      }
      this.currentState = "loginFailed";
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
