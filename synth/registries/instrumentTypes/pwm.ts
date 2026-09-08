// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.
// Replaces: `case InstrumentType.pwm:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';

export const pwmSpec: InstrumentTypeSpec = {
    type: InstrumentType.pwm,
    isNoise: false,
    hasSpecialInterval: false,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.pwm],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.chord = Config.chords.dictionary["arpeggio"].index;
        instrument.pulseWidth = Config.pulseWidthRange;
        instrument.decimalOffset = 0;
    },
};

instrumentTypeRegistry.register(pwmSpec);
