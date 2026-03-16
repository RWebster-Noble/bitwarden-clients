# Bitwarden Clients - AI Assistant Guidelines

## Overview

This is the Bitwarden Clients monorepo containing multiple client applications (Web, Browser Extension, Desktop, CLI) built with Angular, TypeScript, and Nx. The codebase follows strict architectural patterns with shared libraries.

## Technology Stack

- **Framework**: Angular 20+ with standalone components and signals
- **Build System**: Nx (Nrwl) monorepo with Angular CLI
- **Language**: TypeScript 5.8+ with strict mode
- **Styling**: TailwindCSS 3.4+
- **State Management**: RxJS 7.8+ with custom state management abstractions
- **Testing**: Jest with Angular testing utilities
- **Linting**: ESLint with Angular, RxJS, and custom Bitwarden plugins
- **Package Manager**: npm with workspaces

## Project Structure

```
Bitwarden-clients/
├── apps/
│   ├── web/                    # Web Vault (Angular SPA)
│   ├── browser/                # Browser Extension (MV3)
│   ├── desktop/                # Electron Desktop App
│   └── cli/                    # Node.js CLI
├── bitwarden_license/          # Commercial licensed code
│   ├── bit-web/
│   ├── bit-cli/
│   ├── bit-browser/
│   └── bit-common/
└── libs/                       # Shared libraries
    ├── common/                 # Core domain logic (base of dependency tree)
    ├── shared/                 # Shared utilities (no dependencies)
    ├── angular/                # Angular-specific utilities
    ├── components/             # UI component library
    ├── auth/                   # Authentication
    ├── vault/                  # Vault/cipher management
    ├── key-management/         # Crypto/key operations
    ├── platform/               # Platform abstractions
    ├── state/                  # State management
    └── [30+ other libs]
```

## Critical Rules by Application

### Web Vault (`apps/web/`)

- **NEVER** access browser extension APIs (`chrome.*`/`browser.*`)
- **ALWAYS** assume multi-tenant organization features
- **CRITICAL**: All sensitive operations must work without local storage
- Use organization permission guards: `/apps/web/src/app/admin-console/organizations/guards/`

### Browser Extension (`apps/browser/`)

- **NEVER** use `chrome.*` or `browser.*` APIs directly in business logic
  - Always use `BrowserApi` abstraction: `/apps/browser/src/platform/browser/browser-api.ts`
- **ALWAYS** use `BrowserApi.addListener()` for event listeners in popup context
  - Safari requires manual cleanup to prevent memory leaks
- **CRITICAL**: Safari has tab query bugs
  - Use `BrowserApi.tabsQueryFirstCurrentWindowForSafari()` when querying current window tabs
- Extension uses Web Extension API **Manifest V3**
  - Service workers replace background pages
  - Background context runs as service worker (can be terminated anytime)
  - `chrome.extension.getBackgroundPage()` returns `null` in MV3

### Desktop (`apps/desktop/`)

- **CRITICAL**: Separate main process vs renderer process contexts
  - Main process: Node.js + Electron APIs (files in `/apps/desktop/src/main/`)
  - Renderer process: Browser-like environment (Angular app files)
  - Use IPC for cross-process communication
- **NEVER** import Node.js modules directly in renderer process
- **NEVER** import Angular modules in the main process
  - Use preload scripts or IPC to access Node.js functionality

### CLI (`apps/cli/`)

- **ALWAYS** output structured JSON when `process.env.BW_RESPONSE === "true"`
  - Use Response objects from `/apps/cli/src/models/response/`
- **NEVER** use `console.log()` for output
  - Use `CliUtils.writeLn()` to respect `BW_QUIET` and `BW_RESPONSE`
  - Use `ConsoleLogService` from the `ServiceContainer`
- **ALWAYS** respect `BW_CLEANEXIT` environment variable
  - Exit code 0 even on errors when set

## Coding Conventions

### Angular Patterns

- Use **standalone components** (no NgModules)
- Use **signals** for state management (`input()`, `model()`, `computed()`)
- Use `OnPush` change detection for all components
- Use `inject()` for dependency injection instead of constructor injection
- Prefix component selectors with `bit-` (e.g., `bit-button`)

Example:

```typescript
@Component({
  selector: "bit-button",
  templateUrl: "button.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [SpinnerComponent],
})
export class ButtonComponent {
  readonly buttonType = input<ButtonType>("secondary");
  readonly loading = model<boolean>(false);
  private readonly el = inject(ElementRef<HTMLButtonElement>);
}
```

### RxJS Patterns

- Use `takeUntilDestroyed()` for component lifecycle management
- Never expose subjects publicly (use `asObservable()`)
- Prefer signals over observables for simple state

### TailwindCSS

- Use `tw-` prefix for all Tailwind classes
- Custom classes must be whitelisted in ESLint config
- Use design tokens (e.g., `tw-bg-primary-600`, `!tw-text-contrast`)

### State Management

- Use custom state abstractions (`StateProvider`, `GlobalState`, `SingleUserState`)
- Domain state lives in library abstractions
- Component state uses Angular signals

## Dependency Rules

The codebase enforces strict dependency boundaries:

1. **Common is the base**: `libs/common` should not import from other libs (except `shared`)
2. **No circular dependencies**: Enforced by ESLint
3. **Libs cannot import apps**: Only apps import libs
4. **Specific import restrictions**:
   - Commercial SDK: Use `@bitwarden/sdk-internal` NOT `@bitwarden/commercial-sdk-internal`
   - No direct imports from `**/platform/**/internal`
   - No relative imports across libs (`**/src/**/*`)

### Library Dependency Hierarchy

```
shared (no deps)
  ↓
common (only shared)
  ↓
platform, auth, key-management, state
  ↓
components, ui, angular, vault, tools
  ↓
admin-console (can depend on all)
```

## Testing

- Use Jest with `jest-preset-angular`
- Mock services using `jest-mock-extended`
- Fake state providers: `FakeStateProvider`, `FakeAccountService`
- Use `toSignal()` and `toObservable()` helpers for testing signals

## ESLint Rules

Key enforced rules:

- `@angular-eslint/prefer-on-push-component-change-detection`: error
- `@angular-eslint/prefer-signals`: error
- `@bitwarden/platform/required-using`: error
- `@bitwarden/platform/no-enums`: error
- `rxjs-angular/prefer-takeuntil`: error with `takeUntilDestroyed`
- `rxjs/no-exposed-subjects`: error
- `import/order`: Enforces import grouping (builtin → external → @bitwarden → src)
- `no-console`: error (except in specific files)

## Nx Commands

```bash
# Build
nx build web
nx build browser
nx build desktop
nx build cli

# Test
nx test <project>
nx test <project> --watch

# Lint
nx lint <project>

# Run apps
nx serve web
```

## File Naming

- Components: `*.component.ts`
- Services: `*.service.ts`
- Directives: `*.directive.ts`
- Pipes: `*.pipe.ts`
- Guards: `*.guard.ts`
- Resolvers: `*.resolver.ts`
- Models: `*.model.ts` or in `models/` directory
- Enums: `*.enum.ts`
- Abstractions: `*.abstraction.ts` (interfaces for services)

## Security Considerations

- Never store sensitive data in localStorage/sessionStorage (Web Vault)
- Use proper sanitization for DOM manipulation
- Follow Content Security Policy guidelines
- Use `DomSanitizer` when rendering user content

## Common Patterns

### Creating a Component

```typescript
import { Component, input, ChangeDetectionStrategy } from "@angular/core";

@Component({
  selector: "bit-my-component",
  templateUrl: "my-component.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [],
})
export class MyComponent {
  readonly title = input<string>();
}
```

### Creating a Service

```typescript
import { Injectable } from "@angular/core";

export abstract class MyService {
  abstract doSomething(): void;
}

@Injectable({ providedIn: "root" })
export class DefaultMyService implements MyService {
  doSomething(): void {
    // Implementation
  }
}
```

### Using State

```typescript
// Inject state provider
private stateProvider = inject(StateProvider);

// Create state
private myState = this.stateProvider.getGlobal(MY_STATE);

// Use in component
readonly data = toSignal(this.myState.state$, { initialValue: [] });
```

## Storybook

- Component library uses Storybook for documentation
- Run: `npm run storybook`
- Stories located in `*.stories.ts` files alongside components

## Migration Patterns

The codebase is actively migrating:

- From NgModules to standalone components
- From RxJS to signals for component state
- From custom CSS to TailwindCSS
- Follow existing patterns in files you modify
