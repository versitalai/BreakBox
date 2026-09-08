# BreakBox Refactor Plan — Modular Foundation

## Goal
Transform BreakBox into a deeply modular, extensible foundation **without changing a single bit of behavior**. New features should be addable via isolated modules/configuration, not invasive changes across unrelated code.

## Current Architecture Pain Points

### 1. Monolithic `synth/model.ts` (7,267 lines)
- Contains EVERYTHING: Note, Pattern, Instrument, Channel, Song classes + URL serialization + JSON serialization + InstrumentType dispatch + preset application + custom sample loading + built-in sample arrays
- **Coupling**: `Instrument setTypeAndReset` is a 13-case switch that hardcodes instrument-specific defaults. Adding a new instrument type requires editing this massive switch.
- **Coupling**: `Song.toBase64String/fromBase64String` — 2000+ lines of URL serialization, with per-tag-code logic scattered through a single massive switch
- **Coupling**: `PresetUpdates.ts` functions are called inline during deserialization

### 2. Monolithic `synth/dsp.ts` (8,351 lines)
- Contains: PickedString, EnvelopeComputer, Tone, InstrumentState, Synth engine, JIT-compiled chip synth templates (string-based codegen), `computeTone`, `render`, `getInstrumentSynthFunction`
- **Coupling**: `getInstrumentSynthFunction` is a giant if/else chain routing instrument types to `chipSynth`/`loopableChipSynth`/etc — JIT templates are raw strings embedded in TS
- **Coupling**: DSP constants hardcoded as `Config.foo` throughout — no way to swap synthesis algorithms
- **Coupling**: `computeTone` is ~500 lines of pitch/interval math with per-instrument-type branches

### 3. Monolithic `editor/core/EditorConfig.ts` (3,108 lines)
- Contains: Platform detection, preset categories (200+ instrument presets), tag lists, utility functions, `isMobile`, `prettyNumber`
- **Coupling**: All 200+ presets are hardcoded inline — adding a preset requires editing this file
- **Coupling**: Preset application logic in `changes.ts` `ChangePreset` directly references `EditorConfig.presetCategories`

### 4. Monolithic `editor/core/ColorConfig.ts` (7,423 lines)
- Contains: All color schemes, channel colors, the full color palette for every UI element
- **Coupling**: Hardcoded color constants, no theme extension mechanism

### 5. Monolithic `editor/core/changes.ts` (5,732 lines)
- Contains: 100+ Change classes for undo/redo, each tightly coupled to specific model fields
- **Coupling**: Each Change class directly manipulates fields like `instrument.volume`, `song.scale`, etc. — no abstraction layer
- **Pattern**: `ChangeX extends ChangeInstrumentSlider` with a 2-line constructor, but the pattern isn't systematized

### 6. Monolithic `editor/widgets/SongEditor.ts` (5,884 lines)
- Contains: The entire main UI — instrument settings rows, sliders, checkboxes, event handlers, layout
- **Coupling**: Instrument settings UI is a massive method that builds rows for each instrument field with hardcoded if/else visibility logic
- **Coupling**: Every instrument setting row is manually wired with `addEventListener`

### 7. Audio Engine Abstraction (Partial/Fragmented)
- `AudioEngineApi.ts` defines the interface (good!)
- `LegacySynthAdapter` wraps `Synth` (good!)
- `WorkletSynthAdapter` does feature-detection + fallback (good!)
- `BreakBoxAudioEngine` is the worklet impl (good!)
- **But**: `SongDocument` hardcodes `new WorkletSynthAdapter()` — no DI. `BreakBoxAudioEngine.init()` hardcodes `'/breakbox-processor.js'` absolute path (known bug from skill docs).

### 8. Build System (Scattered Shell Scripts)
- 4 separate `compile_*.sh` scripts with duplicated tsc+rollup+terser boilerplate
- Hardcoded output paths, terser mangle patterns, OFFLINE define
- **No config-driven build target registration** — adding a new build target means copying a shell script

### 9. Global State
- `global/Events.ts`: singleton `events` EventManager — used for cross-cutting concerns, no type safety
- `sampleLoadingState` / `sampleLoadEvents`: module-level singletons in SynthConfig.ts

## Refactor Strategy: Layered Modularization

Phase 1: **Foundation — Interfaces + Registries + DI**
Phase 2: **Synth Core Modularization**
Phase 3: **Editor Modularization**
Phase 4: **Build System Modernization**
Phase 5: **Testing Infrastructure**
Phase 6: **Final Review + Polish**

---

## Phase 1: Foundation — Interfaces, Registries, DI Container

### 1.1. DI Container (`synth/DI.ts`)
```typescript
// Minimal DI container — no external deps, preserves exact behavior
export class DIContainer {
    private services: Map<string, any> = new Map();
    register<T>(token: symbol | string, impl: T): void;
    resolve<T>(token: symbol | string): T;
}
export const di = new DIContainer();
```
Purpose: Replace hardcoded `new X()` with `di.resolve(IToken)` — enables swapping implementations.

### 1.2. Registry Pattern for Enums + Config (`synth/registries/`)
Extract the giant enums and their associated metadata into registry interfaces:
- `InstrumentTypeRegistry` — maps `InstrumentType` → `{ defaults, synthFunction, isChipLike, isNoise, ... }`
- `EffectTypeRegistry` — maps `EffectType` → `{ name, appliesTo: InstrumentType[] }`
- `EnvelopeComputeIndexRegistry` — maps automation targets
- `AutomationTargetRegistry`

**Before**: Adding an instrument type = edit enum + 3 arrays in SynthConfig + switch in model.ts + switch in dsp.ts
**After**: Register a new `InstrumentTypeSpec` in one place, and all subsystems pick it up

### 1.3. Serialization Registry (`synth/serializer/`)
- `SongSerializer` — handles URL base64 format
- `JsonSerializer` — handles JSON format
- `TagHandler` interface — each `SongTagCode` becomes a registered handler
- `InstrumentPresetApplier` — registered handlers per instrument type

### 1.4. Feature Flags / Config (`synth/config/`)
- Extract `Config` constants into a typed config object
- Extract `OFFLINE` global into a runtime config provider (testable without `declare global`)

### 1.5. Change Factory Pattern (`editor/core/changes/`)
- `ChangeFactory` — registers change constructors by name, enabling dynamic undo action creation
- Each Change class becomes a thin module that registers itself

### 1.6. Preset Provider (`editor/presets/`)
- `PresetProvider` — loads presets from a JSON file or inline registration
- `EditorConfig.presetCategories` becomes `PresetProvider.getCategories()`
- Presets can be added via JSON merge without recompilation

### 1.7. Theme Provider (`editor/themes/`)
- `ThemeProvider` — `ColorConfig` becomes a registered theme
- Themes are pluggable modules (JSON + color functions)

### 1.8. Audio Engine Provider (`synth/audio/`)
- `AudioEngineFactory` — feature-detects + instantiates the right `AudioEngineApi`
- `SongDocument` resolves via DI instead of hardcoding `new WorkletSynthAdapter()`
- Fix the `'/breakbox-processor.js'` absolute path bug

## Phase 2: Synth Core Modularization

### 2.1. Extract `Config` into `synth/config/Config.ts`
Move the giant `Config` class from `SynthConfig.ts` into its own file. `SynthConfig.ts` becomes the enum/type definitions only.

### 2.2. Split `model.ts` into domain modules
- `model/Note.ts`
- `model/Pattern.ts`
- `model/Operator.ts`
- `model/Instrument.ts` (with `InstrumentTypeRegistry` dispatch)
- `model/Channel.ts`
- `model/Song.ts` (with `SongSerializer` delegation)

Each module exports its class + a registration hook. The barrel (`synth/synth.ts`) re-exports everything exactly as before for backwards compatibility.

### 2.3. Extract URL Serialization into `synth/serializer/UrlSongSerializer.ts`
- `TagHandler` interface: `{ tagCode: SongTagCode; write(song, buffer): void; read(song, reader): void }`
- Each tag handler is a separate class, registered in a `TagHandlerRegistry`
- `Song.toBase64String` delegates to `UrlSongSerializer.write(song)` which iterates registered handlers
- `Song.fromBase64String` delegates to `UrlSongSerializer.read(song, str)` which dispatches on tag code

**Behavior preservation**: The order of tag writes must be EXACTLY preserved. The `default: throw` behavior for unknown tags must be preserved.

### 2.4. Extract DSP Instrument Functions into `synth/dsp/instruments/`
- `chipSynthSource.ts` — the JIT template for chip synthesis
- `loopableChipSynthSource.ts` — the JIT template for loopable chip
- `getInstrumentSynthFunction.ts` — registry-based dispatch instead of if/else chain
- `computeTone.ts` — extract the pitch/interval computation, inject instrument-type-specific handlers

### 2.5. Extract Sample Loading into `synth/samples/SampleLoader.ts`
- Move `startLoadingSample`, `sampleLoadingState`, `sampleLoadEvents` into a `SampleManager` class
- `SampleManager` is injectable, implements an interface
- URL normalization (`_normalizeUrl`) becomes a registered `UrlNormalizer` strategy

## Phase 3: Editor Modularization

### 3.1. Extract `EditorConfig.ts` preset data into `editor/presets/`
- `editor/presets/categories.json` — all preset category definitions
- `editor/presets/RetroPresets.ts`, `KeyboardPresets.ts`, etc. — split by category
- `EditorConfig` loads from `PresetProvider` at startup
- **Behavior preservation**: Exact same preset objects, same ordering

### 3.2. Extract `ColorConfig.ts` into `editor/themes/`
- `editor/themes/light.ts`, `editor/themes/dark.ts`, etc.
- `ThemeProvider` manages theme switching
- `ColorConfig` becomes a facade over `ThemeProvider`

### 3.3. Instrument Settings Rows → Registry-Based
**Current problem**: `SongEditor.ts` has a ~1500-line method that manually creates rows for each instrument setting:
```typescript
if (instrument.type == InstrumentType.chip) {
    _volumeSliderRow.style.display = "";
    _waveSelectorRow.style.display = "";
    ...
}
```
Adding a new instrument setting requires touching this method + the visibility update method + the event handler registration.

**Refactor**: 
- `InstrumentSettingSpec` interface: `{ id, label, type: 'slider'|'checkbox'|'selector', predicate: (instrument) => boolean, create: (doc) => HTMLElement, onChange: (doc, value) => Change }`
- `InstrumentSettingsRegistry` — registers specs
- `SongEditor` iterates registered specs instead of hardcoded rows
- Each setting spec is its own module under `editor/settings/`

### 3.4. Prompt Registry
- `PromptRegistry` — each prompt extends `BasePrompt` and registers itself
- `SongEditor` looks up prompts by ID from the registry instead of importing them individually
- `editor/prompts/index.ts` auto-discovers prompt modules

### 3.5. Change Factory
- Move Change classes from `changes.ts` into individual files under `editor/core/changes/`
- Each module registers its Change class with a `ChangeFactory`
- `changes.ts` becomes a barrel that re-exports + registers all changes
- This makes it possible to add new change types without touching the monolithic file

## Phase 4: Build System Modernization

### 4.1. Config-Driven Build System
Replace 4 shell scripts with a single `rollup.config.js` + `tsconfig` that uses a build manifest:

```typescript
// build.config.ts
export const buildTargets = {
    synth: { entry: 'synth/synth.ts', tsconfig: 'tsconfig_synth_only.json', output: 'website/beepbox_synth.js', target: 'iife', name: 'beepbox', mangleProps: true },
    player: { entry: 'player/main.ts', tsconfig: 'tsconfig_player.json', output: 'website/player/beepbox_player.js', target: 'iife', name: 'beepbox', mangleProps: true },
    editor: { entry: 'editor/main.ts', tsconfig: 'tsconfig_editor.json', output: 'website/beepbox_editor.js', target: 'iife', name: 'beepbox', mangleProps: true },
    processor: { entry: 'synth/BreakBoxProcessor.ts', tsconfig: 'tsconfig_processor.json', output: 'website/breakbox-processor.js', target: 'esm', name: null, mangleProps: false },
};
```

### 4.2. Environment Provider
- Replace `declare global { const OFFLINE: boolean }` with an `Environment` interface
- Default impl reads from the global, but testable environments can be injected
- `OFFLINE` is accessed via `env.isOffline()` instead of bare global reference

### 4.3. Deploy Script as Config-Driven Tool
- Single `scripts/build.js` Node script that reads `build.config.ts`
- Handles tsc + rollup + terser for each target
- Deployment sync to repo root is part of the build (config-driven)

## Phase 5: Testing Infrastructure

### 5.1. Test Setup
- Add `jest.config.js` + `tsconfig.test.json`
- Tests run via `npm test` — no browser needed for synth/core tests
- Use the VM sandbox pattern from the BreakBox skill docs

### 5.2. Regression Tests
- URL round-trip tests for every SongTagCode
- JSON round-trip tests
- Instrument type default tests
- Preset application tests
- Note/pattern clone tests

### 5.3. Behavior Snapshot Tests
- Capture the output of `Synth.render()` for a set of test songs
- Compare after each refactor to ensure zero behavior change
- These are the ultimate safety net

## Phase 6: Final Review

Walk the architecture asking: "To add a new instrument type / new effect / new UI widget / new preset category / new audio engine / new build target — how many files must I touch outside the new module?"

Target: **Zero files outside the new module** for most additions.

---

## Execution Rules
1. After every file move/split: run `npx tsc --noEmit` on all 4 configs
2. After every change: run `npm run build-synth && npm run build-editor` 
3. Verify URL round-trip for existing songs (smoke test)
4. Verify built bundles are byte-identical in behavior (compare minified output hashes)
5. Never change the public export surface of `synth/synth.ts`
6. Never change the `AudioEngineApi` interface shape
7. Never change the `Change` class interface
