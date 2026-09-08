// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.
// Replaces: `case InstrumentType.supersaw:` in Instrument.setTypeAndReset()

import { InstrumentType } from '../../SynthConfig';
import { instrumentTypeRegistry, InstrumentTypeSpec } from '../InstrumentTypeRegistry';
import { Config } from '../../SynthConfig';
import { Instrument } from '../../model';

export const supersawSpec: InstrumentTypeSpec = {
    type: InstrumentType.supersaw,
    isNoise: false,
    hasSpecialInterval: false,
    isChipLike: false,
    displayName: Config.instrumentTypeNames[InstrumentType.supersaw],
    applyDefaults: (instrument: Instrument, isNoiseChannel: boolean) => {
        instrument.chord = Config.chords.dictionary["arpeggio"].index;
        instrument.supersawDynamism = Config.supersawDynamismMax;
        instrument.supersawSpread = Math.ceil(Config.supersawSpreadMax / 2.0);
        instrument.supersawShape = 0;
        instrument.pulseWidth = Config.pulseWidthRange - 1;
        instrument.decimalOffset = 0;
    },
};

instrumentTypeRegistry.register(supersawSpec);
