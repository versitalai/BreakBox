// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.
// Replaces: `case InstrumentType.mod:` in Instrument.setTypeAndReset()

import { InstrumentType, Config } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Instrument } from '../../model';

export const modSpec: InstrumentTypeSpec = {
    type: InstrumentType.mod,
    isNoise: false,
    hasSpecialInterval: false,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.mod],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.transition = 0;
        instrument.vibrato = 0;
        instrument.interval = 0;
        instrument.effects = 0;
        instrument.chord = 0;
        instrument.modChannels = [];
        instrument.modInstruments = [];
        instrument.modulators = [];
        for (let mod: number = 0; mod < Config.modCount; mod++) {
            instrument.modChannels.push(-2);
            instrument.modInstruments.push(0);
            instrument.modulators.push(Config.modulators.dictionary["none"].index);
            instrument.invalidModulators[mod] = false;
            instrument.modFilterTypes[mod] = 0;
            instrument.modEnvelopeNumbers[mod] = 0;
        }
    },
};

instrumentTypeRegistry.register(modSpec);
