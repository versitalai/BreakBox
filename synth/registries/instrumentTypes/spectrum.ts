// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Registers the spectrum instrument type spec.
// Replaces the `case InstrumentType.spectrum:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';

export const spectrumSpec: InstrumentTypeSpec = {
    type: InstrumentType.spectrum,
    isNoise: false,
    hasSpecialInterval: false,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.spectrum],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.chord = Config.chords.dictionary["simultaneous"].index;
        instrument.spectrumWave.reset(isNoiseChannel);
    },
};

instrumentTypeRegistry.register(spectrumSpec);
