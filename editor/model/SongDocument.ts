// cross-ref: interacts with editor/audio/{WorkletSynthAdapter}; editor/core/{Change, ChangeNotifier, ColorConfig, EditorConfig, Layout, Preferences, Selection, changes}; editor/widgets/{SongPerformance}; synth/{AudioEngineApi, SynthConfig, synth}
// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

import { Config } from "../../synth/SynthConfig";
import { isMobile } from "../core/EditorConfig";
import { Pattern, Channel, Song, Synth } from "../../synth/synth";
import { SongRecovery, generateUid, errorAlert } from "./SongRecovery";
import { ColorConfig } from "../core/ColorConfig";
import { Layout } from "../core/Layout";
import { SongPerformance } from "../widgets/SongPerformance";
import { Selection } from "../core/Selection";
import { Preferences } from "../core/Preferences";
import { Change } from "../core/Change";
import { ChangeNotifier } from "../core/ChangeNotifier";
import { ChangeSong, setDefaultInstruments, discardInvalidPatternInstruments, ChangeHoldingModRecording } from "../core/changes";
import { AudioEngineApi } from "../../synth/AudioEngineApi";
import { WorkletSynthAdapter } from "../audio/WorkletSynthAdapter";

interface HistoryState {
    canUndo: boolean;
    sequenceNumber: number;
    bar: number;
    channel: number;
    instrument: number;
    recoveryUid: string;
    prompt: string | null;
    selection: { x0: number, x1: number, y0: number, y1: number, start: number, end: number };
}

export class SongDocument {
    public colorTheme: string;
    public song: Song;
    public synth: Synth; // Kept for UI queries (playhead, playing, etc.)
    public audioEngine: AudioEngineApi; // New: actual audio playback
    public performance: SongPerformance;
    public readonly notifier: ChangeNotifier = new ChangeNotifier();
    public readonly selection: Selection = new Selection(this);
    public readonly prefs: Preferences = new Preferences();
    public channel: number = 0;
    public muteEditorChannel: number = 0;
    public bar: number = 0;
    public recalcChannelNames: boolean;
    public recentPatternInstruments: number[][] = [];
    public viewedInstrument: number[] = [];
    public recordingModulators: boolean = false;
    public continuingModRecordingChange: ChangeHoldingModRecording | null = null;

    public trackVisibleBars: number = 16;
    public trackVisibleChannels: number = 4;
    public barScrollPos: number = 0;
    public channelScrollPos: number = 0;
    public prompt: string | null = null;

    public addedEffect: boolean = false;
    public addedEnvelope: boolean = false;
    public currentPatternIsDirty: boolean = false;
    public modRecordingHandler: () => void;

    private static readonly _maximumUndoHistory: number = 300;
    private _recovery: SongRecovery = new SongRecovery();
    private _recoveryUid: string;
    private _recentChange: Change | null = null;
    private _sequenceNumber: number = 0;
    private _lastSequenceNumber: number = 0;
    private _stateShouldBePushed: boolean = false;
    private _recordedNewSong: boolean = false;
    public _waitingToUpdateState: boolean = false;

    constructor() {
        this.notifier.watch(this._validateDocState);

        ColorConfig.setTheme(this.prefs.colorTheme);
        Layout.setLayout(this.prefs.layout);

        if (window.sessionStorage.getItem("currentUndoIndex") == null) {
            window.sessionStorage.setItem("currentUndoIndex", "0");
            window.sessionStorage.setItem("oldestUndoIndex", "0");
            window.sessionStorage.setItem("newestUndoIndex", "0");
        }

        let songString: string = window.location.hash;
        if (songString == "") {
            songString = this._getHash();
        }
        try {
            this.song = new Song(songString);
            if (songString == "" || songString == undefined) {
                setDefaultInstruments(this.song);
                this.song.scale = this.prefs.defaultScale;
            }
        } catch (error) {
            errorAlert(error);
        }
        songString = this.song.toBase64String();

        // Keep Synth for UI/queries
        this.synth = new Synth(this.song);
        this.synth.volume = this._calcVolume();
        this.synth.anticipatePoorPerformance = isMobile;

        // New: AudioWorklet-backed engine for actual playback.
        // Pass the song-carrying legacy synth so the fallback path plays audio
        // (a fresh null-song synth would be silent).
        this.audioEngine = new WorkletSynthAdapter(this.synth);
        this.audioEngine.onTick = (tick: number) => {
            // Sync playhead from worklet to legacy synth for UI
            this.synth.playhead = tick;
            this._onPlayheadUpdate(tick);
        };

        // Initialize audio engine asynchronously
        this.initializeAudioEngine();

        let state: HistoryState | null = this._getHistoryState();
        if (state == null) {
            state = { canUndo: false, sequenceNumber: 0, bar: 0, channel: 0, instrument: 0, recoveryUid: generateUid(), prompt: null, selection: this.selection.toJSON() };
        }
        if (state.recoveryUid == undefined) state.recoveryUid = generateUid();
        this._replaceState(state, songString);
        window.addEventListener("hashchange", this._whenHistoryStateChanged);
        window.addEventListener("popstate", this._whenHistoryStateChanged);

        this.bar = state.bar | 0;
        this.channel = state.channel | 0;
        for (let i: number = 0; i <= this.channel; i++) this.viewedInstrument[i] = 0;
        this.viewedInstrument[this.channel] = state.instrument | 0;
        this._recoveryUid = state.recoveryUid;
        this.prompt = state.prompt;
        this.selection.fromJSON(state.selection);
        this.selection.scrollToSelectedPattern();

        // For all input events, catch them when they are about to finish bubbling,
        // presumably after all handlers are done updating the model, then update the
        // view before the screen renders. mouseenter and mouseleave do not bubble,
        // but they are immediately followed by mousemove which does. 
        for (const eventName of ["change", "click", "keyup", "mousedown", "mouseup", "touchstart", "touchmove", "touchend", "touchcancel"]) {
            window.addEventListener(eventName, this._cleanDocument);
        }
        for (const eventName of ["keydown", "input", "mousemove"]) {
            window.addEventListener(eventName, this._cleanDocumentIfNotRecordingMods);
        }

        this._validateDocState();
        this.performance = new SongPerformance(this);
    }

    private async initializeAudioEngine(): Promise<void> {
        await this.audioEngine.init();
        this.audioEngine.setSong(this.song);
    }

    private _onPlayheadUpdate(tick: number): void {
        // Update bar position for UI (track editor, scrollbar, etc.)
        const partsPerBar = this.song.beatsPerBar * 4; // Config.partsPerBeat = 4
        this.bar = Math.floor(tick / partsPerBar);
        // Trigger UI update
        this.notifier.notifyWatchers();
    }

    // Audio engine delegation — keeps legacy synth for reads, routes writes to worklet
    public play(): void {
        this.audioEngine.play();
        this.synth.enableMetronome = false;
        this.synth.countInMetronome = false;
        this.synth.maintainLiveInput();
    }

    public pause(): void {
        this.audioEngine.pause();
        this.synth.resetEffects();
        this.synth.enableMetronome = false;
        this.synth.countInMetronome = false;
        if (this.prefs.autoFollow) {
            this.seek(this.bar);
        }
        this.snapToBar();
    }

    public stop(): void {
        this.audioEngine.stop();
    }

    public seek(tick: number): void {
        this.audioEngine.seek(tick);
    }

    public goToBar(bar: number): void {
        this.audioEngine.seek(bar * this.song.beatsPerBar * 4); // parts per bar
    }

    public snapToBar(): void {
        // Sync legacy synth's bar position
        this.synth.snapToBar();
    }

    public maintainLiveInput(): void {
        this.synth.maintainLiveInput();
    }

    public get playing(): boolean {
        return this.synth.playing;
    }

    public get recording(): boolean {
        return this.synth.recording;
    }

    public get playhead(): number {
        return this.synth.playhead;
    }

    public set playhead(value: number) {
        this.synth.playhead = value;
    }

    public get loopBarStart(): number {
        return this.synth.loopBarStart;
    }

    public get loopBarEnd(): number {
        return this.synth.loopBarEnd;
    }

    public get enableMetronome(): boolean {
        return this.synth.enableMetronome;
    }
    public set enableMetronome(value: boolean) {
        this.synth.enableMetronome = value;
    }

    public get countInMetronome(): boolean {
        return this.synth.countInMetronome;
    }
    public set countInMetronome(value: boolean) {
        this.synth.countInMetronome = value;
    }

    public resetEffects(): void {
        this.synth.resetEffects();
    }

    public startRecording(): void {
        this.synth.startRecording();
    }

    // Live input properties (delegate to legacy synth)
    public get liveInputPitches(): number[] {
        return this.synth.liveInputPitches;
    }
    public set liveInputPitches(value: number[]) {
        this.synth.liveInputPitches = value;
    }
    public get liveInputChannel(): number {
        return this.synth.liveInputChannel;
    }
    public set liveInputChannel(value: number) {
        this.synth.liveInputChannel = value;
    }
    public get liveInputDuration(): number {
        return this.synth.liveInputDuration;
    }
    public set liveInputDuration(value: number) {
        this.synth.liveInputDuration = value;
    }
    public get liveInputStarted(): boolean {
        return this.synth.liveInputStarted;
    }
    public set liveInputStarted(value: boolean) {
        this.synth.liveInputStarted = value;
    }
    public get liveInputInstruments(): number[] {
        return this.synth.liveInputInstruments;
    }
    public set liveInputInstruments(value: number[]) {
        this.synth.liveInputInstruments = value;
    }

    public get liveBassInputPitches(): number[] {
        return this.synth.liveBassInputPitches;
    }
    public set liveBassInputPitches(value: number[]) {
        this.synth.liveBassInputPitches = value;
    }
    public get liveBassInputChannel(): number {
        return this.synth.liveBassInputChannel;
    }
    public set liveBassInputChannel(value: number) {
        this.synth.liveBassInputChannel = value;
    }
    public get liveBassInputDuration(): number {
        return this.synth.liveBassInputDuration;
    }
    public set liveBassInputDuration(value: number) {
        this.synth.liveBassInputDuration = value;
    }
    public get liveBassInputStarted(): boolean {
        return this.synth.liveBassInputStarted;
    }
    public set liveBassInputStarted(value: boolean) {
        this.synth.liveBassInputStarted = value;
    }
    public get liveBassInputInstruments(): number[] {
        return this.synth.liveBassInputInstruments;
    }
    public set liveBassInputInstruments(value: number[]) {
        this.synth.liveBassInputInstruments = value;
    }

    public toggleDisplayBrowserUrl() {
        const state: HistoryState | null = this._getHistoryState();
        if (state == null) throw new Error("History state is null.");
        this.prefs.displayBrowserUrl = !this.prefs.displayBrowserUrl;
        this._replaceState(state, this.song.toBase64String());
    }

    private _getHistoryState(): HistoryState | null {
        if (this.prefs.displayBrowserUrl) {
            return window.history.state;
        } else {
            const json: any = JSON.parse(window.sessionStorage.getItem(window.sessionStorage.getItem("currentUndoIndex")!)!);
            return json == null ? null : json.state;
        }
    }

    private _getHash(): string {
        if (this.prefs.displayBrowserUrl) {
            return window.location.hash;
        } else {
            const json: any = JSON.parse(window.sessionStorage.getItem(window.sessionStorage.getItem("currentUndoIndex")!)!);
            return json == null ? "" : json.hash;
        }
    }

    private _replaceState(state: HistoryState, hash: string): void {
        if (this.prefs.displayBrowserUrl) {
            window.history.replaceState(state, "", "#" + hash);
        } else {
            window.sessionStorage.setItem(window.sessionStorage.getItem("currentUndoIndex") || "0", JSON.stringify({ state, hash }));
            window.history.replaceState(null, "", location.pathname);
        }
    }

    private _pushState(state: HistoryState, hash: string): void {
        if (this.prefs.displayBrowserUrl) {
            window.history.pushState(state, "", "#" + hash);
        } else {
            let currentIndex: number = Number(window.sessionStorage.getItem("currentUndoIndex"));
            let oldestIndex: number = Number(window.sessionStorage.getItem("oldestUndoIndex"));
            currentIndex = (currentIndex + 1) % SongDocument._maximumUndoHistory;
            window.sessionStorage.setItem("currentUndoIndex", String(currentIndex));
            window.sessionStorage.setItem("newestUndoIndex", String(currentIndex));
            if (currentIndex == oldestIndex) {
                oldestIndex = (oldestIndex + 1) % SongDocument._maximumUndoHistory;
                window.sessionStorage.setItem("oldestUndoIndex", String(oldestIndex));
            }
            window.sessionStorage.setItem(String(currentIndex), JSON.stringify({ state, hash }));
            window.history.replaceState(null, "", location.pathname);
        }
        this._lastSequenceNumber = state.sequenceNumber;
    }

	public hasRedoHistory(): boolean {
		return this._lastSequenceNumber > this._sequenceNumber;
	}	
		
	private _forward(): void {
		if (this.prefs.displayBrowserUrl) {
			window.history.forward();
		} else {
			let currentIndex: number = Number(window.sessionStorage.getItem("currentUndoIndex"));
			let newestIndex: number = Number(window.sessionStorage.getItem("newestUndoIndex"));
			if (currentIndex != newestIndex) {
				currentIndex = (currentIndex + 1) % SongDocument._maximumUndoHistory;
				window.sessionStorage.setItem("currentUndoIndex", String(currentIndex));
				setTimeout(this._whenHistoryStateChanged);
			}
		}
	}
		
	private _back(): void {
		if (this.prefs.displayBrowserUrl) {
			window.history.back();
		} else {
			let currentIndex: number = Number(window.sessionStorage.getItem("currentUndoIndex"));
			let oldestIndex: number = Number(window.sessionStorage.getItem("oldestUndoIndex"));
			if (currentIndex != oldestIndex) {
				currentIndex = (currentIndex + SongDocument._maximumUndoHistory - 1) % SongDocument._maximumUndoHistory;
				window.sessionStorage.setItem("currentUndoIndex", String(currentIndex));
				setTimeout(this._whenHistoryStateChanged);
			}
		}
	}
		
	private _whenHistoryStateChanged = (): void => {
		if (this.synth.recording) {
			// Changes to the song while it's recording to could mess up the recording so just abort the recording.
			this.performance.abortRecording();
		}
		
		if (window.history.state == null && window.location.hash != "") {
			// The user changed the hash directly.
			this._sequenceNumber++;
			this._resetSongRecoveryUid();
			const state: HistoryState = {canUndo: true, sequenceNumber: this._sequenceNumber, bar: this.bar, channel: this.channel, instrument: this.viewedInstrument[this.channel], recoveryUid: this._recoveryUid, prompt: null, selection: this.selection.toJSON()};
			try {
				new ChangeSong(this, this._getHash());
			} catch (error) {
				errorAlert(error);
			}
			this.prompt = state.prompt;
			if (this.prefs.displayBrowserUrl) {
				this._replaceState(state, this.song.toBase64String());
			} else {
				this._pushState(state, this.song.toBase64String());
			}
			this.forgetLastChange();
			this.notifier.notifyWatchers();
			// Stop playing, and go to start when pasting new song in.
			this.synth.pause();
			this.synth.goToBar(0);
			return;
		}
			
		const state: HistoryState | null = this._getHistoryState();
		if (state == null) throw new Error("History state is null.");
			
		// Abort if we've already handled the current state. 
		if (state.sequenceNumber == this._sequenceNumber) return;
			
		this.bar = state.bar;
		this.channel = state.channel;
		this.viewedInstrument[this.channel] = state.instrument;
		this._sequenceNumber = state.sequenceNumber;
		this.prompt = state.prompt;
		try {
			new ChangeSong(this, this._getHash());
		} catch (error) {
			errorAlert(error);
		}
			
		this._recoveryUid = state.recoveryUid;
		this.selection.fromJSON(state.selection);
			
		//this.barScrollPos = Math.min(this.bar, Math.max(this.bar - (this.trackVisibleBars - 1), this.barScrollPos));
			
		this.forgetLastChange();
		this.notifier.notifyWatchers();
	}
		
	private _cleanDocument = (): void => {
		this.notifier.notifyWatchers();
	}

    private _cleanDocumentIfNotRecordingMods = (): void => {
        if (!this.recordingModulators)
            this.notifier.notifyWatchers();
        else {
            this.modRecordingHandler();
        }

    }

    private _validateDocState = (): void => {
        const channelCount: number = this.song.getChannelCount();
        for (let i: number = this.recentPatternInstruments.length; i < channelCount; i++) {
            this.recentPatternInstruments[i] = [0];
        }
        this.recentPatternInstruments.length = channelCount;
        for (let i: number = 0; i < channelCount; i++) {
            if (i == this.channel) {
                if (this.song.patternInstruments) {
                    const pattern: Pattern | null = this.song.getPattern(this.channel, this.bar);
                    if (pattern != null) {
                        this.recentPatternInstruments[i] = pattern.instruments.concat();
                    }
                } else {
                    const channel: Channel = this.song.channels[this.channel];
                    for (let j: number = 0; j < channel.instruments.length; j++) {
                        this.recentPatternInstruments[i][j] = j;
                    }
                    this.recentPatternInstruments[i].length = channel.instruments.length;
                }
            }
            discardInvalidPatternInstruments(this.recentPatternInstruments[i], this.song, i);
        }

        for (let i: number = this.viewedInstrument.length; i < channelCount; i++) {
            this.viewedInstrument[i] = 0;
        }
        this.viewedInstrument.length = channelCount;
        for (let i: number = 0; i < channelCount; i++) {
            if (this.song.patternInstruments && !this.song.layeredInstruments && i == this.channel) {
                const pattern: Pattern | null = this.song.getPattern(this.channel, this.bar);
                if (pattern != null) {
                    this.viewedInstrument[i] = pattern.instruments[0];
                }
            }
            this.viewedInstrument[i] = Math.min(this.viewedInstrument[i] | 0, this.song.channels[i].instruments.length - 1);
        }

        const highlightedPattern: Pattern | null = this.getCurrentPattern();
        if (highlightedPattern != null && this.song.patternInstruments) {
            this.recentPatternInstruments[this.channel] = highlightedPattern.instruments.concat();
        }

        // Normalize selection.
        // I'm allowing the doc.bar to drift outside the box selection while playing
        // because it may auto-follow the playhead outside the selection but it would
        // be annoying to lose your selection just because the song is playing.
        if ((!this.synth.playing && (this.bar < this.selection.boxSelectionBar || this.selection.boxSelectionBar + this.selection.boxSelectionWidth <= this.bar)) ||
            this.channel < this.selection.boxSelectionChannel ||
            this.selection.boxSelectionChannel + this.selection.boxSelectionHeight <= this.channel ||
            this.song.barCount < this.selection.boxSelectionBar + this.selection.boxSelectionWidth ||
            channelCount < this.selection.boxSelectionChannel + this.selection.boxSelectionHeight ||
            (this.selection.boxSelectionWidth == 1 && this.selection.boxSelectionHeight == 1)) {
            this.selection.resetBoxSelection();
        }

        this.barScrollPos = Math.max(0, Math.min(this.song.barCount - this.trackVisibleBars, this.barScrollPos));
        this.channelScrollPos = Math.max(0, Math.min(this.song.getChannelCount() - this.trackVisibleChannels, this.channelScrollPos));

    }

    private _updateHistoryState = (): void => {
        this._waitingToUpdateState = false;
        let hash: string;
        try {
            // Ensure that the song is not corrupted before saving it.
            hash = this.song.toBase64String();
        } catch (error) {
            errorAlert(error);
            return;
        }
        if (this._stateShouldBePushed) this._sequenceNumber++;
        if (this._recordedNewSong) {
            this._resetSongRecoveryUid();
        } else {
            this._recovery.saveVersion(this._recoveryUid, this.song.title, hash);
        }
        let state: HistoryState = { canUndo: true, sequenceNumber: this._sequenceNumber, bar: this.bar, channel: this.channel, instrument: this.viewedInstrument[this.channel], recoveryUid: this._recoveryUid, prompt: this.prompt, selection: this.selection.toJSON() };
        if (this._stateShouldBePushed) {
            this._pushState(state, hash);
        } else {
            this._replaceState(state, hash);
        }
        this._stateShouldBePushed = false;
        this._recordedNewSong = false;
    }

    public record(change: Change, replace: boolean = false, newSong: boolean = false): void {
        if (change.isNoop()) {
            this._recentChange = null;
            if (replace) this._back();
        } else {
            change.commit();
            this._recentChange = change;
            this._stateShouldBePushed = this._stateShouldBePushed || !replace;
            this._recordedNewSong = this._recordedNewSong || newSong;
            if (!this._waitingToUpdateState) {
                // Defer updating the url/history until all sequenced changes have
                // committed and the interface has rendered the latest changes to
                // improve perceived responsiveness.
                window.requestAnimationFrame(this._updateHistoryState);
                this._waitingToUpdateState = true;
            }
        }
    }

    private _resetSongRecoveryUid(): void {
        this._recoveryUid = generateUid();
    }

    public openPrompt(prompt: string): void {
        this.prompt = prompt;
        const hash: string = this.song.toBase64String();
        this._sequenceNumber++;
        const state = { canUndo: true, sequenceNumber: this._sequenceNumber, bar: this.bar, channel: this.channel, instrument: this.viewedInstrument[this.channel], recoveryUid: this._recoveryUid, prompt: this.prompt, selection: this.selection.toJSON() };
        this._pushState(state, hash);
    }

    public undo(): void {
        const state: HistoryState | null = this._getHistoryState();
        if (state == null || state.canUndo) this._back();
    }

    public redo(): void {
        this._forward();
    }

    public setProspectiveChange(change: Change | null): void {
        this._recentChange = change;
    }

    public forgetLastChange(): void {
        this._recentChange = null;
    }

    public checkLastChange(): Change | null {
        return this._recentChange;
    }

    public lastChangeWas(change: Change | null): boolean {
        return change != null && change == this._recentChange;
    }

    public goBackToStart(): void {
        this.bar = 0;
        this.channel = 0;
        this.barScrollPos = 0;
        this.channelScrollPos = 0;
        this.synth.snapToStart();
        this.notifier.changed();
    }

    public setVolume(val: number): void {
        this.prefs.volume = val;
        this.prefs.save();
        this.synth.volume = this._calcVolume();
    }

    private _calcVolume(): number {
        return Math.min(1.0, Math.pow(this.prefs.volume / 50.0, 0.5)) * Math.pow(2.0, (this.prefs.volume - 75.0) / 25.0);
    }

    public getCurrentPattern(barOffset: number = 0): Pattern | null {
        return this.song.getPattern(this.channel, this.bar + barOffset);
    }

    public getCurrentInstrument(barOffset: number = 0): number {
        if (barOffset == 0) {
            return this.viewedInstrument[this.channel];
        } else {
            const pattern: Pattern | null = this.getCurrentPattern(barOffset);
            return pattern == null ? 0 : pattern.instruments[0];
        }
    }

    public getMobileLayout(): boolean {
        return (this.prefs.layout == "wide") ? window.innerWidth <= 1000 : window.innerWidth <= 710;
    }

    public getBarWidth(): number {
        // Bugfix: In wide fullscreen, the 32 pixel display doesn't work as the trackEditor is still horizontally constrained
        return (!this.getMobileLayout() && this.prefs.enableChannelMuting && (!this.getFullScreen() || this.prefs.layout == "wide")) ? 30 : 32;
    }

    public getChannelHeight(): number {
        const squashed: boolean = this.getMobileLayout() || this.song.getChannelCount() > 4 || (this.song.barCount > this.trackVisibleBars && this.song.getChannelCount() > 3);
        // TODO: Jummbox widescreen should allow more channels before squashing or megasquashing
        const megaSquashed: boolean = !this.getMobileLayout() && (((this.prefs.layout != "wide") && this.song.getChannelCount() > 11) || this.song.getChannelCount() > 22);
        return megaSquashed ? 23 : (squashed ? 27 : 32);
    }

    public getFullScreen(): boolean {
        return !this.getMobileLayout() && (this.prefs.layout != "small");
    }

    public getVisibleOctaveCount(): number {
        return this.getFullScreen() ? this.prefs.visibleOctaves : Preferences.defaultVisibleOctaves;
    }

    public getVisiblePitchCount(): number {
        return this.getVisibleOctaveCount() * Config.pitchesPerOctave + 1;
    }

    public getBaseVisibleOctave(channel: number): number {
        const visibleOctaveCount: number = this.getVisibleOctaveCount();
        return Math.max(0, Math.min(Config.pitchOctaves - visibleOctaveCount, Math.ceil(this.song.channels[channel].octave - visibleOctaveCount * 0.5)));
    }
}