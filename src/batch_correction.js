import * as scran from "scran.js";
import * as utils from "./utils/general.js";
import * as filter_module from "./cell_filtering.js";
import * as combine_module from "./combine_embeddings.js";

export class BatchCorrectionState {
    #filter;
    #combined;
    #parameters;
    #cache;

    constructor(filter, combined, parameters = null, cache = null) {
        if (!(filter instanceof filter_module.CellFilteringState)) {
            throw new Error("'filter' should be a CellFilteringState object");
        }
        this.#filter = filter;

        if (!(combined instanceof combine_module.CombineEmbeddingsState)) {
            throw new Error("'pca' should be a CombineEmbeddingsState object");
        }
        this.#combined = combined;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#cache = (cache === null ? {} : cache);
        this.changed = false;
    }

    /***************************
     ******** Getters **********
     ***************************/

    fetchPCs() {
        let upstream = this.#combined.fetchPCs();
        if (this.#parameters.method == "mnn") {
            upstream.pcs = this.#cache.corrected;
        } 
        return upstream;
    }

    /***************************
     ******** Compute **********
     ***************************/

    compute(method) {
        this.changed = false;

        if (this.#filter.changed || this.#combined.changed || method !== this.#parameters.method) { 
            if (method == "mnn") {
                let corrected = utils.allocateCachedArray(pcs.length, "Float64Array", this.#cache, "corrected");
                let block = this.#filter.fetchFilteredBlock();
                let pcs = this.#combined.fetchPCs();
                scran.mnnCorrect(pcs.pcs, block, { buffer: corrected, numberOfCells: pcs.num_obs, numberOfDims: pcs.num_pcs });
            }

            this.#parameters.method = method;
            this.changed = true;
        }
    }

    /**************************
     ******** Results**********
     **************************/

    summary() {
        return {};
    }
}
