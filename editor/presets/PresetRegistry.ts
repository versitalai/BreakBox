// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

// cross-ref: Used by editor/core/EditorConfig.ts (presetCategories),
//   editor/widgets/SongEditor.ts (preset selection UI),
//   editor/core/changes.ts (random instrument generation)
//
// Provides a registry-based API over the static preset data in EditorConfig.ts.
// This enables:
//   1. Querying presets by tag, type, or ID without hardcoding
//   2. Adding new presets at runtime (plugin/extensibility use case)
//   3. Testability — presets can be mocked/injected
//   4. Future migration — presets can be loaded from external data files

import { Preset, PresetCategory } from "../core/EditorConfig";
import { toNameMap } from "../../synth/SynthConfig";

/**
 * Registry for instrument presets.
 *
 * Wraps the static `EditorConfig.presetCategories` with a queryable,
 * extensible API. The registry is initialized from the static data
 * (zero behavior change) but supports runtime registration of new presets.
 */
export class PresetRegistry {
    private _categories: Map<string, PresetCategory> = new Map();
    private _presetsById: Map<number, Preset> = new Map();
    private _presetsByTag: Map<string, Preset[]> = new Map();
    private _presetsByType: Map<string, Preset[]> = new Map();
    private _frozen: boolean = false;

    /**
     * Register a preset category. Throws if a category with the same name exists.
     */
    addCategory(category: PresetCategory): void {
        if (this._frozen) throw new Error("PresetRegistry is frozen");
        if (this._categories.has(category.name)) {
            throw new Error("Preset category already registered: " + category.name);
        }
        this._categories.set(category.name, category);
        for (const preset of category.presets) {
            this._indexPreset(preset);
        }
    }

    /**
     * Register a single preset (optionally in a category).
     */
    addPreset(categoryName: string, preset: Preset): void {
        if (this._frozen) throw new Error("PresetRegistry is frozen");
        let category = this._categories.get(categoryName);
        if (category == undefined) {
            // Create a new category with a generated index
            const newIndex = this._categories.size;
            category = { name: categoryName, index: newIndex, presets: toNameMap([]) } as PresetCategory;
            this._categories.set(categoryName, category);
        }
        (category.presets as any).push(preset);
        this._indexPreset(preset);
    }

    /** Index a preset by ID, tags, and type. */
    private _indexPreset(preset: Preset): void {
        if (preset.id != undefined) {
            this._presetsById.set(preset.id, preset);
        }
        if (preset.tags) {
            for (const tag of preset.tags) {
                let list = this._presetsByTag.get(tag);
                if (list == undefined) {
                    list = [];
                    this._presetsByTag.set(tag, list);
                }
                list.push(preset);
            }
        }
        if (preset.settings?.type) {
            let list = this._presetsByType.get(preset.settings.type);
            if (list == undefined) {
                list = [];
                this._presetsByType.set(preset.settings.type, list);
            }
            list.push(preset);
        }
    }

    /**
     * Look up a preset by its numeric ID.
     */
    getById(id: number): Preset | undefined {
        return this._presetsById.get(id);
    }

    /**
     * Find presets matching a tag (e.g., "chip", "retro", "fm").
     */
    getByTag(tag: string): Preset[] {
        return this._presetsByTag.get(tag) ?? [];
    }

    /**
     * Find presets matching an instrument type (e.g., "chip", "FM", "PWM").
     */
    getByType(type: string): Preset[] {
        return this._presetsByType.get(type) ?? [];
    }

    /**
     * Find presets matching multiple tags (all must match).
     */
    getByTags(tags: string[]): Preset[] {
        const results: Preset[] = [];
        for (const preset of this._presetsById.values()) {
            if (preset.tags && tags.every(t => preset.tags.includes(t))) {
                results.push(preset);
            }
        }
        return results;
    }

    /**
     * Get all preset categories.
     */
    getAllCategories(): PresetCategory[] {
        return Array.from(this._categories.values());
    }

    /**
     * Get a category by name.
     */
    getCategory(name: string): PresetCategory | undefined {
        return this._categories.get(name);
    }

    /**
     * Freeze the registry — no more presets can be added.
     * Call this after initialization to catch accidental registrations.
     */
    freeze(): void {
        this._frozen = true;
    }

    /**
     * Clear all registered presets and categories. Useful for test isolation.
     */
    reset(): void {
        this._frozen = false;
        this._categories.clear();
        this._presetsById.clear();
        this._presetsByTag.clear();
        this._presetsByType.clear();
    }
}

/**
 * Initialize a PresetRegistry from the static EditorConfig.presetCategories.
 * This is the bridge between the old static data and the new registry API.
 */
export function createPresetRegistry(categories: ReadonlyArray<PresetCategory>): PresetRegistry {
    const registry = new PresetRegistry();
    for (const category of categories) {
        registry.addCategory(category);
    }
    registry.freeze();
    return registry;
}

/**
 * Create an empty preset registry (no initial data).
 * Useful for tests that want to inject their own presets.
 */
export function createEmptyPresetRegistry(): PresetRegistry {
    return new PresetRegistry();
}
