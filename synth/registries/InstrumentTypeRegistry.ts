// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Used by model.ts (Instrument.setTypeAndReset), dsp.ts (getInstrumentSynthFunction),
//   editor/core/EditorConfig.ts (presetCategories), editor/core/changes.ts (random instrument generation)
//
// Replaces the giant switch statement in Instrument.setTypeAndReset() and the
// if/else chain in Synth.getInstrumentSynthFunction() with a registered,
// extensible system. Adding a new instrument type is now a matter of
// registering an InstrumentTypeSpec — no edits to model.ts or dsp.ts needed.

import { InstrumentType } from '../SynthConfig';
import { Instrument } from '../model';

/**
 * A function that applies type-specific default values to an Instrument.
 *
 * This replaces the per-case body in Instrument.setTypeAndReset().
 * Each instrument type spec provides its own applyDefaults callback
 * that sets fields as needed (chipWave, chord, algorithm, spectrumWave.reset(), etc.)
 */
export type ApplyDefaultsFn = (instrument: Instrument, isNoiseChannel: boolean) => void;

/**
 * Specification for how a particular InstrumentType behaves.
 *
 * Each instrument type registers a spec that declares:
 * - Its display name (from TypePresets, kept in sync by index)
 * - Whether it has special interval handling (noise, FM, etc.)
 * - Whether it is chip-like (uses wave/unison/loop controls)
 * - Whether it is a noise-channel instrument
 * - A callback to apply type-specific defaults on creation/type-change
 *
 * This eliminates the need for giant switch/if-else chains scattered
 * across model.ts, dsp.ts, EditorConfig.ts, and changes.ts.
 */
export interface InstrumentTypeSpec {
    /** The instrument type enum value (must match position in InstrumentType enum). */
    readonly type: InstrumentType;
    /** Whether this is a noise-channel instrument. */
    readonly isNoise: boolean;
    /** Whether this instrument type has special interval handling. */
    readonly hasSpecialInterval: boolean;
    /** Whether this instrument is chip-like (uses wave/unison/loop controls). */
    readonly isChipLike: boolean;
    /** Display name (index into TypePresets array). */
    readonly displayName: string;
    /** Callback to apply type-specific defaults (replaces the case body in setTypeAndReset). */
    readonly applyDefaults: ApplyDefaultsFn;
}

/**
 * Registry for instrument type specifications.
 *
 * This is the single source of truth for instrument-type behavior.
 * All subsystems (model serialization, DSP dispatch, UI presets, etc.)
 * consult this registry instead of hardcoding type checks.
 *
 * To add a new instrument type:
 *   1. Add it to the InstrumentType enum in SynthConfig.ts
 *   2. Add its name to TypePresets in SynthConfig.ts
 *   3. Create a spec module that registers its InstrumentTypeSpec
 *
 * That's it — model.ts, dsp.ts, and EditorConfig.ts all pick up the new type
 * automatically through their registry lookups.
 */
export class InstrumentTypeRegistry {
    private specs: Map<InstrumentType, InstrumentTypeSpec> = new Map();

    /** Register an instrument type spec. */
    register(spec: InstrumentTypeSpec): void {
        this.specs.set(spec.type, spec);
    }

    /**
     * Look up the spec for a given instrument type.
     * Throws if the type is not registered (catch-all error preserving
     * the old `default: throw new Error("Unrecognized instrument type")` behavior).
     */
    get(type: InstrumentType): InstrumentTypeSpec {
        const spec = this.specs.get(type);
        if (spec === undefined) {
            throw new Error("Unrecognized instrument type: " + type);
        }
        return spec;
    }

    /** Check if a registered instrument type exists. */
    has(type: InstrumentType): boolean {
        return this.specs.has(type);
    }

    /** Get all registered specs in enum order. */
    getAll(): InstrumentTypeSpec[] {
        return Array.from(this.specs.entries())
            .sort((a, b) => a[0] - b[0])
            .map(e => e[1]);
    }
}

/**
 * The global instrument type registry.
 *
 * Instrument type specs self-register on import. The barrel module
 * `synth/registries/InstrumentTypes.ts` imports all spec modules,
 * ensuring they're registered before use.
 */
export const instrumentTypeRegistry: InstrumentTypeRegistry = new InstrumentTypeRegistry();
