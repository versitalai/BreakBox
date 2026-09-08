// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.
// Replaces: `case InstrumentType.fm6op:` in Instrument.setTypeAndReset()

import { InstrumentType, Config } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Instrument } from '../../model';

export const fm6opSpec: InstrumentTypeSpec = {
    type: InstrumentType.fm6op,
    isNoise: false,
    hasSpecialInterval: false,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.fm6op],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.transition = 1;
        instrument.vibrato = 0;
        instrument.effects = 1;
        instrument.chord = 3;
        instrument.algorithm = 0;
        instrument.feedbackType = 0;
        instrument.algorithm6Op = 1;
        instrument.feedbackType6Op = 1;
        instrument.customAlgorithm.fromPreset(1);
        instrument.feedbackAmplitude = 0;
        for (let i: number = 0; i < instrument.operators.length; i++) {
            instrument.operators[i].reset(i);
        }
    },
};

instrumentTypeRegistry.register(fm6opSpec);
