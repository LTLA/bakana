import * as scran from "scran.js";
import * as utils from "./utils/general.js";
import * as nutils from "./utils/normalization.js";
import * as markers from "./utils/markers.js";
import * as filter_module from "./cell_filtering.js";
import * as norm_module from "./normalization.js";

export const step_name = "custom_selections";

/**
 * Applications can perform marker detection on custom selections of cells.
 * This allows users to dynamically select cells on a UI and quickly obtain a list of distinguishing markers for that selection.
 * This wraps the `scoreMarkers` function from [**scran.js**](https://github.com/jkanche/scran.js).
 *
 * Methods not documented here are not part of the stable API and should not be used by applications.
 * @hideconstructor
 */
export class CustomSelectionsState {
    #filter;
    #norm_states;
    #cache;
    #parameters;

    constructor(filter, norm_states, parameters = null, cache = null) {
        if (!(filter instanceof filter_module.CellFilteringState)) {
            throw new Error("'filter' should be a State object from './cell_filtering.js'");
        }
        this.#filter = filter;

        for (const norm of Object.values(norm_states)) {
            if (!(norm instanceof nutils.NormalizationStateBase)) {
                throw new Error("'norm' should be a NormalizationStateBase object");
            }
        }
        this.#norm_states = norm_states;

        this.#cache = (cache === null ? { "results": {} } : cache); 
        this.#parameters = (parameters === null ? { "selections": {} } : parameters);
        this.changed = false;
    }

    #liberate(i) {
        for (const [k, v] of Object.entries(this.#cache.results[i].raw)) {
            v.free();                                                
        }
    }

    free() {
        utils.freeCache(this.#cache.buffer);
        for (const k of Object.keys(this.#cache.results)) {
            this.#liberate(k);
        }
    }

    /***************************
     ******** Setters **********
     ***************************/

    /**
     * Add a custom selection and compute its markers.
     *
     * @param {string} id A unique identifier for the new custom selection.
     * @param {Array|TypedArray} selection The indices of the cells in the selection.
     * Indices should refer to positions of cells in the QC-filtered matrix, not the original matrix.
     * @param {object} [options] - Optional parameters.
     * @param {boolean} [options.copy=true] - Whether to make a copy of `selection` before storing it inside this object.
     * If `false`, it is assumed that the caller makes no further modifications to the passed `selection`.
     *
     * @return The custom selection is added to the state and calculation of its markers is performed.
     * Nothing is returned.
     */
    addSelection(id, selection, { copy = true } = {}) {
        let to_use = utils.findValidUpstreamStates(this.#norm_states);
        let mat = this.#norm_states[to_use[0]].fetchNormalizedMatrix();
        utils.checkIndices(selection, mat.numberOfColumns());

        // Assumes that we have at least one cell in and outside the selection!
        var buffer = utils.allocateCachedArray(mat.numberOfColumns(), "Int32Array", this.#cache);
        buffer.fill(0);
        var tmp = buffer.array();
        selection.forEach(element => { tmp[element] = 1; });

        let res = {};
        for (const k of to_use) {
            let v = this.#norm_states[k];
            if (v.valid()) {
                let mat = v.fetchNormalizedMatrix();
                res[k] = scran.scoreMarkers(mat, buffer); 
            }
        }
              
        // Removing previous results, if there were any.
        if (id in this.#cache.results) {
            this.#liberate(id);
        }
      
        this.#cache.results[id] = { "raw": res };

        // making a copy to take ownership.
        if (copy) {
            selection = selection.slice();
        }
        this.#parameters.selections[id] = selection;
        return;
    }

    /**
     * Remove a custom selection and its results from the state.
     *
     * @param {string} id - An identifier for the selection to be removed.
     *
     * @return The specified selection and its results are removed from the state.
     * Nothing is returned.
     */
    removeSelection(id) {
        this.#liberate(id);
        delete this.#cache.results[id];
        delete this.#parameters.selections[id];
        return;
    }

    /***************************
     ******** Getters **********
     ***************************/

    /**
     * Fetch the marker results for a custom selection.
     * 
     * @param {string} id - An identifier for the desired selection.
     * @param {string} rank_type - Effect size to use for ranking markers.
     * This should be one of `lfc`, `cohen`, `auc` or `delta_detected`.
     * @param {string} feat_type - The feature type of interest, usually `"RNA"` or `"ADT"`.
     *
     * @return An object containing the marker statistics for the selection, sorted by the specified effect and summary size from `rank_type`.
     * This contains:
     * - `means`: a `Float64Array` of length equal to the number of genes, containing the mean expression within the selection.
     * - `detected`: a `Float64Array` of length equal to the number of genes, containing the proportion of cells with detected expression inside the selection.
     * - `lfc`: a `Float64Array` of length equal to the number of genes, containing the log-fold changes for the comparison between cells inside and outside the selection.
     * - `delta_detected`: a `Float64Array` of length equal to the number of genes, containing the difference in the detected proportions between cells inside and outside the selection.
     */
    fetchResults(id, rank_type, feat_type) {
        var current = this.#cache.results[id].raw[feat_type];
        return markers.fetchGroupResults(current, 1, rank_type + "-mean"); 
    }

    /**
     * Retrieve the indices for a selection of interest.
     *
     * @param {string} id - The identifier for the selection.
     * @param {object} [options] - Optional parameters.
     * @param {boolean} [options.copy=true] - Whether to make a copy of `selection` before returning it.
     * If `false`, it is assumed that the caller does not modify the selection.
     *
     * @return {Array|TypedArray} Array of indices in the requested selection.
     * Note that indices are relative to the filtered matrix - 
     * use {@linkcode CellFilteringState#undoFiltering CellFilteringState.undoFiltering} to convert them to indices on the original dataset.
     */
    fetchSelectionIndices(id, { copy = true } = {}) {
        let raw = this.#parameters.selections[id];
        if (copy) {
            raw = raw.slice();
        }
        return raw;
    }

    /**
     * Retrieve indices for all selections.
     *
     * @return {object} Object where the keys are the selection names and the values are arrays of indices for each selection.
     * Each array is a copy and can be modified without affecting the CustomSelectionsState.
     * See {@linkcode CustomSelectionsState#fetchSelectionIndices fetchSelectionIndices} for more details on the interpretation of the indices.
     */
    fetchSelections() {
        let replacement = {};
        for (const [k, v] of Object.entries(this.#parameters.selections)) {
            replacement[k] = v.slice(); 
        }
        return replacement;        
    }

    fetchParameters() {
        return {};
    }

    /***************************
     ******** Compute **********
     ***************************/

    /**
     * This method should not be called directly by users, but is instead invoked by {@linkcode runAnalysis}.
     *
     * @return The state is updated by removing stale selections if the QC filter was altered.
     */
    compute() {
        this.changed = false;

        /* If the QC filter was re-run, all of the selections are invalidated as
         * the identity of the indices may have changed.
         */
        if (this.#filter.changed) {
            for (const key of Object.entries(this.#cache.results)) {
                this.#liberate(key);
            }
            this.#parameters.selections = {};
            this.#cache.results = {};
            this.changed = true;
        }

        /*
         * Technically we would need to re-run detection on the existing selections
         * if the normalization changed but the QC was the same. In practice, this
         * never happens, so we'll deal with it later.
         */

        return;
    }

    static defaults() {
        return {};
    }

    /***************************
     ******** Results **********
     **************************/

    /**
     * Obtain a summary of the state, typically for display on a UI like **kana**.
     *
     * @return An empty object.
     * This is returned for consistency with the other steps.
     */
    summary() {
        return {};
    }

    /*************************
     ******** Saving *********
     *************************/

    serialize(handle) {
        let ghandle = handle.createGroup("custom_selections");

        {
            let phandle = ghandle.createGroup("parameters");
            let shandle = phandle.createGroup("selections");
            for (const [key, val] of Object.entries(this.#parameters.selections)) {
                shandle.writeDataSet(String(key), "Int32", null, val);
            }
        }

        {
            let rhandle = ghandle.createGroup("results");
            let phandle = rhandle.createGroup("per_selection");
            for (const [key, val] of Object.entries(this.#cache.results)) {
                let ihandle = phandle.createGroup(key);
                for (const [key2, val2] of Object.entries(val.raw)) {
                    let ahandle = ihandle.createGroup(key2);
                    markers.serializeGroupStats(ahandle, val2, 1, { no_summaries: true });
                }
            }
        }
    }
}

/**************************
 ******** Loading *********
 **************************/

class CustomMarkersMimic {
    constructor(results) {
        this.results = results;
    }

    effect_grabber(key, group, summary, copy) {
        if (group != 1) {
            throw "only group 1 is supported for custom marker mimics";
        }
        if (summary != 1) {
            throw "only the mean effect size is supported for custom marker mimics";
        }
        let chosen = this.results[group][key];
        return utils.mimicGetter(chosen, copy);
    }

    lfc(group, { summary, copy }) {
        return this.effect_grabber("lfc", group, summary, copy);
    }

    deltaDetected(group, { summary, copy }) {
        return this.effect_grabber("delta_detected", group, summary, copy);
    }

    cohen(group, { summary, copy }) {
        return this.effect_grabber("cohen", group, summary, copy);
    }

    auc(group, { summary, copy }) {
        return this.effect_grabber("auc", group, summary, copy);
    }

    stat_grabber(key, group, copy) {
        let chosen = this.results[group][key];
        return utils.mimicGetter(chosen, copy);
    }

    means(group, { copy }) {
        return this.stat_grabber("means", group, copy);
    }

    detected(group, { copy }) {
        return this.stat_grabber("detected", group, copy);
    }

    free() {}
}

export function unserialize(handle, permuters, filter, norm_states) {
    let ghandle = handle.open("custom_selections");

    let parameters = { selections: {} };
    {
        let phandle = ghandle.open("parameters");
        let shandle = phandle.open("selections");

        for (const key of Object.keys(shandle.children)) {
            let vals = shandle.open(key, { load: true }).values;

            // v1 wasn't sorted, so we make sure to sort things.
            for (var i = 1; i < vals.length; i++) {
                if (vals[i] < vals[i-1]) {
                    vals.sort();
                    break;
                }
            }

            parameters.selections[key] = vals;
        }
    }

    let cache = { results: {} };
    {
        let rhandle = ghandle.open("results");

        if ("markers" in rhandle.children) {
            // before v2.0
            let mhandle = rhandle.open("markers");
            for (const sel of Object.keys(mhandle.children)) {
                let current = markers.unserializeGroupStats(mhandle.open(sel), permuters["RNA"], { no_summaries: true });
                cache.results[sel] = { raw: { RNA: new CustomMarkersMimic({ 1 : current }) } };
            }
        } else {
            // after v2.0.
            let phandle = rhandle.open("per_selection");
            for (const sel of Object.keys(phandle.children)) {
                let shandle = phandle.open(sel);
                let collected = {};
                for (const feat of Object.keys(shandle.children)) {
                    let current = markers.unserializeGroupStats(shandle.open(feat), permuters[feat], { no_summaries: true });
                    collected[feat] = new CustomMarkersMimic({ 1 : current });
                }
                cache.results[sel] = { raw: collected };
            }
        }
    }

    return new CustomSelectionsState(filter, norm_states, parameters, cache);
}

