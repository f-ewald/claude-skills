# Swift Standards

Language-specific standards and libraries for Swift code, focused on **SwiftUI**. These
build on the always-on rules in `CLAUDE.md` / `COPILOT.md`; where this file is more
specific (e.g. formatting), it takes precedence over general Swift conventions where they
conflict.

## Language & platform

- Write **Swift** targeting the **latest stable Swift and Xcode**; prefer modern language
  and framework features and treat the modern API as the default (minimum-version
  requirements are flagged inline below).
- Use **SwiftUI** as the default UI framework for new screens. Drop to UIKit/AppKit only
  for capabilities SwiftUI doesn't yet cover, and wrap them (`UIViewRepresentable` /
  `UIViewControllerRepresentable`) behind a SwiftUI surface.

## Formatting

- **Indentation:** **4 spaces** per level, following the standard Swift/Xcode
  convention; never use tabs.
- **Line length:** hard limit of **120 characters**. Wrap longer lines.
- Braces open on the **same line** (K&R / "One True Brace" style).
- One primary type per file; the file name matches the type it defines.
- Organize larger files with `// MARK:` sections; group stored properties, then
  initializers, then methods.

## Naming

Follow the [Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/).

- **Clarity at the point of use** is the top goal, and **clarity beats brevity** — read a
  call site, not just the declaration.
- `UpperCamelCase` for types and protocols; `lowerCamelCase` for everything else. No
  Hungarian notation or type prefixes.
- Choose argument labels that make the call read as a phrase (`move(from:to:)`,
  `insert(_:at:)`); omit needless words that merely repeat type information.
- Name booleans as assertions (`isEmpty`, `hasChanges`); give mutating methods imperative
  verbs (`sort()`) and their non-mutating counterparts a past-participle/`-ing` form
  (`sorted()`).

## Types & optionals

- Prefer **value types** (`struct`, `enum`); reach for a `class` only when you need
  reference semantics or identity, and mark it `final` unless it is designed for
  subclassing.
- Favor **protocol-oriented** designs and composition over deep class hierarchies.
- **Never force-unwrap** (`!`) or force-`try` in production paths. Unwrap with `guard let`
  / `if let` (use the shorthand `if let value {}`), `??`, and optional chaining.
- Model recoverable failures with `throws` + `do`/`catch` or `Result`; reserve
  `fatalError` / `precondition` for genuine programmer errors, never for expected runtime
  conditions.

## Concurrency

- Prefer **`async`/`await`** over completion handlers, and structured concurrency (`Task`,
  `async let`, task groups) over manual dispatch.
- Annotate UI-facing state and view models with **`@MainActor`**, and respect `Sendable`
  when passing values across concurrency domains.
- In views, start async work with the **`.task`** modifier so it's tied to the view's
  lifecycle and cancelled automatically.

## Documentation

Document every type and public/`open` member with a **`///` doc comment** in Swift's
DocC-flavored Markdown.

- Open with a **one-line summary fragment**, then optional detail, then `- Parameters:` /
  `- Returns:` / `- Throws:` as applicable.
- Let types live in the signature; describe behavior in prose, not the types.

```swift
/// Computes a weighted engagement score for a list of events.
///
/// - Parameters:
///   - events: The events to score. Must be non-empty.
///   - weight: Multiplier applied to the raw score.
/// - Returns: The weighted engagement score.
/// - Throws: `ScoringError.noEvents` if `events` is empty.
func computeScore(for events: [Event], weight: Double = 1) throws -> Double {
    guard !events.isEmpty else { throw ScoringError.noEvents }
    return events.reduce(0) { $0 + $1.value } * weight
}
```

## SwiftUI — state & data flow

- Model observable state with the **`@Observable` macro** (Observation framework,
  **iOS 17+**); it replaces `ObservableObject` / `@Published` / `@StateObject` /
  `@ObservedObject` for new code.
- Keep **`@State` private** and use it to own a view's local value state and its
  `@Observable` objects; a view **owns** state with `@State`, and children **receive** it.
- Pass mutable value state down as **`@Binding`**. To bind to an `@Observable` object's
  properties, use `$model.property` when the view owns it via `@State`, and **`@Bindable`**
  when the view receives the object from elsewhere.
- Inject shared dependencies through the **`@Environment`** (custom environment keys), not
  global singletons.
- Persist small values with **`@AppStorage`** / **`@SceneStorage`** rather than hand-rolling
  `UserDefaults` access in the view.
- Keep a **single source of truth** and derive the rest with computed properties — never
  copy source state into another `@State`.
- **Own models at a stable boundary** — create an `@Observable` model with `@State` (or
  receive it via `@Environment` / `init`); never instantiate a long-lived model or service
  inside `body`, which would rebuild it on every render.

```swift
@Observable final class CounterModel {
    var count = 0
}

struct CounterView: View {
    @State private var model = CounterModel()

    var body: some View {
        Stepper("Count: \(model.count)", value: $model.count)
    }
}
```

## SwiftUI — views & architecture

- Keep views **small and single-purpose**; when a `body` grows past a screenful or nests
  deeply, **extract subviews** or `@ViewBuilder` computed properties rather than adding
  more branches.
- Use **MVVM with an `@Observable` view model** for non-trivial screens: keep networking,
  persistence, and business logic in the model and keep `body` declarative.
- Inject dependencies via the view model's **initializer** and `@Environment`; avoid
  reaching for singletons inside views.
- **Don't over-engineer** — a plain view plus an `@Observable` model is the default; adopt
  heavier architectures (e.g. TCA) only when the complexity genuinely warrants it.
- Navigate with **`NavigationStack`** and value-based `navigationDestination(for:)`
  (destination values must be `Hashable`); the old `NavigationView` is deprecated.

```swift
struct RootView: View {
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            ProductList()                              // extracted subview
                .navigationDestination(for: Product.self) { ProductDetail(product: $0) }
        }
    }
}
```

## SwiftUI — performance

- Give `ForEach` a **stable identity** (`Identifiable` with a persistent id); never mint a
  fresh `UUID()` per render or use array indices for mutable collections.
- Use **`LazyVStack` / `LazyHStack` / `LazyVGrid`** inside scroll views for large
  collections.
- Keep `body` cheap — hoist expensive computation out of it and cache it on the model. Use
  `.equatable()` only when comparing a view is cheaper than recomputing its `body`, and
  make sure `==` covers every render-affecting input.
- Avoid needless `@State` and over-broad observation that force extra view updates.

## Accessibility & localization

- Treat accessibility as a **requirement, not an add-on**: provide
  `accessibilityLabel` / `Value` / `Hint`, group related elements, support **Dynamic Type**
  (avoid hardcoded font sizes and frames), ensure sufficient contrast, and test with
  VoiceOver.
- Localize all user-facing text with **String Catalogs** (`.xcstrings`, **Xcode 15+**) and
  `LocalizedStringKey`; never hardcode display strings.

## Previews

- Use the **`#Preview` macro** (**Xcode 15+**) rather than the legacy `PreviewProvider`.
- Preview the meaningful states — loading / empty / error, **dark mode**, and large
  **Dynamic Type** — so regressions surface during development.

## Testing

Use the **Swift Testing** framework (`import Testing`, **Xcode 16+**) for new tests.

- Write tests with **`@Test`**, assert with **`#expect`**, and unwrap/precondition with
  **`#require`**; cover multiple inputs with parameterized `arguments:` instead of
  copy-paste.
- **XCTest** remains for existing suites and for UI tests (**`XCUITest`**); the two run
  side-by-side, so migrate incrementally.
- Guard visual regressions with **`swift-snapshot-testing`** (pointfreeco) where
  snapshotting earns its keep.

```swift
import Testing

@Test("Weighted score multiplies the raw total", arguments: [1.0, 2.0])
func weightedScore(weight: Double) throws {
    let events = [Event(value: 3), Event(value: 5)]
    #expect(try computeScore(for: events, weight: weight) == 8 * weight)
}
```

## Tooling

- **Formatting:** **SwiftFormat**. **Linting:** **SwiftLint**. If a project already has a
  formatter/linter configured, leave it in place — don't swap it out or layer another on
  top.
- **Package management:** **Swift Package Manager (SPM)**. CocoaPods and Carthage are
  legacy; don't introduce them into new projects.

## Dependencies

Keep the dependency tree small and deliberate.

- Prefer the platform — Apple's first-party frameworks and the Swift standard library —
  over adding a package.
- If something is small or trivial, **re-implement it** (with a test) rather than taking a
  dependency for it.
- Reserve dependencies for substantial, well-maintained libraries where re-implementing
  would be error-prone, and keep shared helpers in a documented, tested module.

## Libraries & tooling

| Concern | Use |
| --- | --- |
| UI framework | SwiftUI |
| Observable state | Observation (`@Observable`) |
| Navigation | `NavigationStack` |
| Formatting | SwiftFormat |
| Linting | SwiftLint |
| Package management | Swift Package Manager (SPM) |
| Testing | Swift Testing (XCTest / XCUITest for legacy & UI) |
| Snapshot testing | swift-snapshot-testing |
| Previews | `#Preview` |
| Localization | String Catalogs (`.xcstrings`) |
