import { createPresetRegistry } from "../editor/presets/PresetRegistry";
import { EditorConfig, PresetCategory } from "../editor/core/EditorConfig";
import { InstrumentType } from "../synth/SynthConfig";

function category(name: string, presetId: number): PresetCategory {
    return {
        name,
        presets: [{ id: presetId, name: `Preset ${presetId}`, settings: { type: "chip" } }],
    } as PresetCategory;
}

describe("PresetRegistry", () => {
    it("merges duplicate display names from static editor categories", () => {
        const first = category("Misc Modded Presets", 1);
        const second = category("Misc Modded Presets", 2);

        const registry = createPresetRegistry([first, second]);

        expect(registry.getAllCategories()).toHaveLength(1);
        expect(registry.getCategory("Misc Modded Presets")!.presets.map(preset => preset.id)).toEqual([1, 2]);
        expect(registry.getById(1)!.name).toBe("Preset 1");
        expect(registry.getById(2)!.name).toBe("Preset 2");
    });

    it("does not mutate EditorConfig category data while merging", () => {
        const first = category("Shared", 1);
        const second = category("Shared", 2);

        createPresetRegistry([first, second]);

        expect(first.presets.map(preset => preset.id)).toEqual([1]);
        expect(second.presets.map(preset => preset.id)).toEqual([2]);
    });

    it("provides custom presets for every editor-visible instrument type", () => {
        expect(EditorConfig.instrumentToPreset(InstrumentType.fm6op)?.name).toBe("FM (6-op)");
        expect(EditorConfig.valueToPreset(InstrumentType.sampleTrigger)?.name).toBe("sample trigger");
    });
});
