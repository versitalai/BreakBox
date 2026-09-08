// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Registers the FM instrument type spec.
// Replaces the `case InstrumentType.fm:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';

export const fmSpec: InstrumentTypeSpec = {
    type: InstrumentType.fm,
    isNoise: false,
    hasSpecialInterval: false,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.fm],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.chord = Config.chords.dictionary["custom interval"].index;
        instrument.algorithm = 0;
        instrument.feedbackType = 0;
        instrument.feedbackAmplitude = 0;
        for (let i: number = 0; i < instrument.operators.length; i++) {
            instrument.operators[i].reset(i);
        }
    },
};

instrumentTypeRegistry.register(fmSpec);
