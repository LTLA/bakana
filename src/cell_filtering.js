import * as scran from "scran.js"; 
import * as utils from "./utils/general.js";
import * as rutils from "./utils/reader.js";
import * as qcutils from "./utils/quality_control.js";
import * as inputs_module from "./inputs.js";

export const step_name = "cell_filtering";

/**
 * This step filters the count matrices to remove low-quality cells.
 * It wraps the `filterCells` function from [**scran.js**](https://github.com/jkanche/scran.js).
 * For multi-modal datasets, this combines the quality calls from all modalities; a cell is removed if it is considered low-quality in any individual modality.
 *
 * Methods not documented here are not part of the stable API and should not be used by applications.
 * @hideconstructor
 */
export class CellFilteringState {
    #inputs;
    #qc_states;
    #cache;
    #parameters;

    constructor(inputs, qc_states, parameters = null, cache = null) {
        if (!(inputs instanceof inputs_module.InputsState)) {
            throw new Error("'inputs' should be an InputsState");
        }
        this.#inputs = inputs;

        for (const v of Object.values(qc_states)) {
            if (!(v instanceof qcutils.QualityControlStateBase)) {
                throw new Error("'qc_states' should contain QualityControlStateBase objects");
            }
        }
        this.#qc_states = qc_states;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#cache = (cache === null ? {} : cache);
        this.changed = false;
    }

    free() {
        utils.freeCache(this.#cache.block_buffer);
        utils.freeCache(this.#cache.discard_buffer);
        utils.freeCache(this.#cache.matrix);
    }

    /***************************
     ******** Getters **********
     ***************************/

    hasAvailable(type) {
        if ("matrix" in this.#cache) {
            return this.#cache.matrix.has(type);
        } else {
            return this.#inputs.hasAvailable(type);
        }
    }

    fetchFilteredMatrix({ type = "RNA" } = {}) {
        if (!("matrix" in this.#cache)) {
            this.#filter_matrix();
        }
        return this.#cache.matrix.get(type);
    }

    /**
     * Fetch the filtered vector of block assignments.
     *
     * @return An Int32WasmArray of length equal to the number of cells after filtering, containing the block assignment for each cell.
     *
     * Alternatively `null` if no blocks are present in the dataset.
     */
    fetchFilteredBlock() {
        if (!("blocked" in this.#cache)) {
            this.#filter_block();
        }
        return this.#cache.block_buffer;
    }

    fetchDiscards() {
        return this.#cache.discard_buffer;
    }

    /**
     * Fetch an annotation for the cells remaining after QC filtering.
     *
     * @param {string} col - Name of the annotation field of interest.
     *
     * @return An object similar to that returned by {@linkcode InputsState#fetchAnnotations InputsState.fetchAnnotations},
     * after filtering the vectors to only contain information for the remaining cells.
     * - For `type: "factor"`, the array in `index` will be filtered.
     * - For `type: "array"`, the array in `values` will be filtered.
     */
    fetchFilteredAnnotations(col) { 
        let vec = this.#inputs.fetchAnnotations(col);
        var discard = this.#cache.discard_buffer.array();
        let filterfun = (x, i) => !discard[i];
        if (vec.type === "factor") {
            vec.index = vec.index.filter(filterfun);
        } else {
            vec.values = vec.values.filter(filterfun);
        }
        return vec;
    }

    /***************************
     ******** Compute **********
     ***************************/

    #filter_matrix() {
        let to_use = utils.findValidUpstreamStates(this.#qc_states, "QC");
        let disc_buffer;
        let first = this.#qc_states[to_use[0]].fetchDiscards();

        if (to_use.length > 1) {
            // A discard signal in any modality causes the cell to be removed. 
            disc_buffer = utils.allocateCachedArray(first.length, "Uint8Array", this.#cache, "discard_buffer");
            let disc_arr = disc_buffer.array();
            disc_arr.fill(0);
            for (const u of to_use) {
                this.#qc_states[u].fetchDiscards().forEach((y, i) => { disc_arr[i] |= y; });
            }
        } else {
            // If there's only one valid modality, we just create a view on it
            // to avoid unnecessary duplication.
            disc_buffer = first.view();
            utils.freeCache(this.#cache.discard_buffer);
            this.#cache.discard_buffer = disc_buffer;
        }

        // Subsetting all modalities.
        utils.freeCache(this.#cache.matrix);
        this.#cache.matrix = new rutils.MultiMatrix;
        let available = this.#inputs.listAvailableTypes();
        for (const a of available) {
            let src = this.#inputs.fetchCountMatrix({ type: a });
            let sub = scran.filterCells(src, disc_buffer);
            this.#cache.matrix.add(a, sub);
        }
    }

    #filter_block() {
        let block = this.#inputs.fetchBlock();
        if (block !== null) {
            let bcache = utils.allocateCachedArray(this.#cache.matrix.numberOfColumns(), "Int32Array", this.#cache, "block_buffer");
            let bcache_arr = bcache.array();
            let block_arr = block.array();
            let disc_arr = this.#cache.discard_buffer.array();

            let j = 0;
            for (let i = 0; i < block_arr.length; i++) {
                if (disc_arr[i] == 0) {
                    bcache_arr[j] = block_arr[i];
                    j++;
                }
            }
        } else {
            utils.freeCache(this.#cache.block_buffer);
            this.#cache.block_buffer = null;
        }

        return;
    }

    /**
     * This method should not be called directly by users, but is instead invoked by {@linkcode runAnalysis}.
     * Each argument is taken from the property of the same name in the `cell_filtering` property of the `parameters` of {@linkcode runAnalysis}.
     *
     * @return The object is updated with the new results.
     */
    compute() {
        this.changed = false;

        // Checking upstreams.
        if (this.#inputs.changed) {
            this.changed = true;
        }
        for (const x of Object.values(this.#qc_states)) {
            if (x.valid() && x.changed) {
                this.changed = true;
            }
        }

        if (this.changed) {
            this.#filter_matrix();
            this.#filter_block();
        }
    }

    static defaults() {
        return {};
    }

    /***************************
     ******** Results **********
     ***************************/

    /**
     * Obtain a summary of the state, typically for display on a UI like **kana**.
     *
     * @return {Object} An object containing:
     *
     * - `retained`: the number of cells retained after filtering out low-quality cells.
     */
    summary() {
        let remaining = 0;
        this.#cache.discard_buffer.forEach(x => { remaining += (x == 0); });
        return { "retained": remaining };
    }

    /*************************
     ******** Saving *********
     *************************/

    serialize(handle) {
        let ghandle = handle.createGroup(step_name);
        ghandle.createGroup("parameters"); // for tradition

        let rhandle = ghandle.createGroup("results"); 
        let disc = this.fetchDiscards();
        if (disc.owner === null) {
            // If it's not a view, we save it; otherwise, we skip it, under the
            // assumption that only one of the upstream QC states contains the
            // discard vector.
            rhandle.writeDataSet("discards", "Uint8", null, disc);
        }
    }
}

export function unserialize(handle, inputs, qc_states) {
    let ghandle = handle.open(step_name);
    let parameters = CellFilteringState.defaults();

    let output;
    let cache = {};
    try {
        let rhandle = ghandle.open("results");

        if ("discards" in rhandle.children) {
            let discards = rhandle.open("discards", { load: true }).values; 
            cache.discard_buffer = scran.createUint8WasmArray(discards.length);
            cache.discard_buffer.set(discards);
        } else {
            // Figuring out which upstream QC state contains the discard vector
            // and creating a view on it so that our fetchDiscards() works properly.
            let to_use = utils.findValidUpstreamStates(qc_states, "QC");
            if (to_use.length != 1) {
                throw new Error("only one upstream QC state should be valid if 'discards' is not available");
            }
            let use_state = qc_states[to_use[0]];
            cache.discard_buffer = use_state.fetchDiscards().view();
        }

        output = new CellFilteringState(inputs, qc_states, parameters, cache);
    } catch (e) {
        utils.freeCache(cache.discard_buffer);
        utils.freeCache(output);
        throw e;
    }

    return {
        state: output,
        parameters: { ...parameters } // make a copy to avoid pass-by-reference links with state's internal parameters
    };
}
