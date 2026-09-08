// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Registers the noise instrument type spec.
// Replaces the `case InstrumentType.noise:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';

export const noiseSpec: InstrumentTypeSpec = {
    type: InstrumentType.noise,
    isNoise: true,
    hasSpecialInterval: false,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.noise],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.chipNoise = 1;
        instrument.chord = Config.chords.dictionary["arpeggio"].index;
    },
};

instrumentTypeRegistry.register(noiseSpec);
