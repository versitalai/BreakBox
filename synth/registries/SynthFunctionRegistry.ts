// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Used by dsp.ts (Synth.getInstrumentSynthFunction) to replace the
//   giant if/else chain with a registry-based dispatch.
//
// Each instrument type registers a factory that produces the appropriate
// synth function. Adding a new instrument type's DSP dispatch is now a
// one-line registration — no edits to the getInstrumentSynthFunction method.

import { InstrumentType } from '../SynthConfig';
import { Instrument } from '../model';

/**
 * Factory function that produces the synth function for a given instrument.
 * This replaces the per-case body in Synth.getInstrumentSynthFunction().
 */
export type SynthFunctionFactory = (instrument: Instrument) => Function;

/**
 * Registry mapping InstrumentType → synth function factory.
 *
 * To add a new instrument type's DSP dispatch:
 *   1. Implement the synth function (can reuse existing Synth static methods)
 *   2. Register it here via register()
 *
 * The registry is consulted by getInstrumentSynthFunction() instead of
 * the if/else chain, making it trivial to add or replace synth dispatch logic.
 */
export class SynthFunctionRegistry {
    private factories: Map<InstrumentType, SynthFunctionFactory> = new Map();

    register(type: InstrumentType, factory: SynthFunctionFactory): void {
        this.factories.set(type, factory);
    }

    get(type: InstrumentType, instrument: Instrument): Function {
        const factory = this.factories.get(type);
        if (factory === undefined) {
            throw new Error("Unrecognized instrument type: " + instrument.type);
        }
        return factory(instrument);
    }

    has(type: InstrumentType): boolean {
        return this.factories.has(type);
    }
}

/**
 * The global synth function registry.
 *
 * Initialized with all built-in instrument type → synth function mappings.
 * Called by Synth.getInstrumentSynthFunction() as the first dispatch layer.
 */
export const synthFunctionRegistry: SynthFunctionRegistry = new SynthFunctionRegistry();
