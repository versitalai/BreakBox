// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.
// Replaces: `case InstrumentType.pickedString:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';

export const pickedStringSpec: InstrumentTypeSpec = {
    type: InstrumentType.pickedString,
    isNoise: false,
    hasSpecialInterval: true,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.pickedString],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.chord = Config.chords.dictionary["strum"].index;
        instrument.harmonicsWave.reset();
    },
};

instrumentTypeRegistry.register(pickedStringSpec);
