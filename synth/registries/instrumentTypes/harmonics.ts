// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.
// Replaces: `case InstrumentType.harmonics:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';

export const harmonicsSpec: InstrumentTypeSpec = {
    type: InstrumentType.harmonics,
    isNoise: false,
    hasSpecialInterval: true,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.harmonics],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.chord = Config.chords.dictionary["simultaneous"].index;
        instrument.harmonicsWave.reset();
    },
};

instrumentTypeRegistry.register(harmonicsSpec);
