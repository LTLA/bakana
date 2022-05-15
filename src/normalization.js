import * as scran from "scran.js"; 
import * as utils from "./utils/general.js";
import * as qc_module from "./quality_control.js";
import * as filter_module from "./cell_filtering.js";

/**
 * This step performs normalization and log-transformation on the QC-filtered matrix from the {@linkplain QualityControlState}.
 * It wraps the `logNormCounts` function from [**scran.js**](https://github.com/jkanche/scran.js).
 *
 * Methods not documented here are not part of the stable API and should not be used by applications.
 * @hideconstructor
 */
export class NormalizationState {
    #qc
    #filter;
    #parameters;
    #cache;

    constructor(qc, filter, parameters = null, cache = null) {
        if (!(qc instanceof qc_module.QualityControlState)) {
            throw new Error("'filt' should be a State object from './quality_control.js'");
        }
        this.#qc = qc;

        if (!(filter instanceof filter_module.CellFilteringState)) {
            throw new Error("'filt' should be a State object from './cell_filtering.js'");
        }
        this.#filter = filter;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#cache = (cache === null ? {} : cache);
        this.changed = false;
    }

    free() {
        utils.freeCache(this.#cache.matrix);
    }

    /***************************
     ******** Getters **********
     ***************************/

    fetchNormalizedMatrix() {
        if (!("matrix" in this.#cache)) {
            this.#raw_compute();
        }
        return this.#cache.matrix;
    }

    /**
     * Extract normalized expression values.
     * @param {number} index - An integer specifying the row index to extract.
     * @return A Float64Array of length equal to the number of (QC-filtered) cells, containing the log-normalized expression values for each cell.
     */
    fetchExpression(index) {
        var mat = this.fetchNormalizedMatrix();
        var buffer = utils.allocateCachedArray(mat.numberOfColumns(), "Float64Array", this.#cache); // re-using the buffer.
        mat.row(index, { buffer: buffer });
        return buffer.slice();
    }

    /***************************
     ******** Compute **********
     ***************************/

    #raw_compute() {
        var mat = this.#filter.fetchFilteredMatrix({ type: "RNA" });
        var buffer = utils.allocateCachedArray(mat.numberOfColumns(), "Float64Array", this.#cache);

        var discards = this.#filter.fetchDiscards();
        var sums = this.#qc.fetchSums({ unsafe: true }); // Better not have any more allocations in between now and filling of size_factors!

        // Reusing the totals computed earlier.
        var size_factors = buffer.array();
        var j = 0;
        discards.forEach((x, i) => {
            if (!x) {
                size_factors[j] = sums[i];
                j++;
            }
        });

        if (j != mat.numberOfColumns()) {
            throw "normalization and filtering are not in sync";
        }

        var block = this.#filter.fetchFilteredBlock();

        utils.freeCache(this.#cache.matrix);
        this.#cache.matrix = scran.logNormCounts(mat, { sizeFactors: buffer, block: block });
        return;
    }

    /**
     * This method should not be called directly by users, but is instead invoked by {@linkcode runAnalysis}.
     *
     * @return The object is updated with new results.
     */
    compute() {
        this.changed = false;
        if (this.#qc.changed || this.#filter.changed) {
            this.changed = true;
        } 

        if (this.changed) {
            this.#raw_compute();
        }
        return;
    }

    /***************************
     ******** Results **********
     ***************************/

    /**
     * Obtain a summary of the state, typically for display on a UI like **kana**.
     *
     * @return An empty object.
     * This is just provided for consistency with the other classes.
     */
    summary() {
        return {};
    }

    /*************************
     ******** Saving *********
     *************************/

    serialize(handle) {
        // Token effort.
        let ghandle = handle.createGroup("normalization");
        ghandle.createGroup("parameters"); 
        ghandle.createGroup("results"); 
    }
}

/**************************
 ******** Loading *********
 **************************/

export function unserialize(handle, qc) {
    return {
        state: new NormalizationState(qc),
        parameters: {}
    }
}
