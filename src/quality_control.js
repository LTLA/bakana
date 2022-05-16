import * as scran from "scran.js"; 
import * as utils from "./utils/general.js";
import * as qcutils from "./utils/quality_control.js";
import { mito } from "./mito.js";
import * as inputs_module from "./inputs.js";

/**
 * This step applies quality control on the original count matrix.
 * After removing low-quality cells, the filtered matrix is used for all downstream steps.
 * This wraps `computePerCellQCMetrics` and related functions from [**scran.js**](https://github.com/jkanche/scran.js).
 *
 * Methods not documented here are not part of the stable API and should not be used by applications.
 * @hideconstructor
 */
export class QualityControlState extends qcutils.QualityControlStateBase {
    #inputs;
    #cache;
    #parameters;

    constructor(inputs, parameters = null, cache = null) {
        super();

        if (!(inputs instanceof inputs_module.InputsState)) {
            throw new Error("'inputs' should be a State object from './inputs.js'");
        }
        this.#inputs = inputs;

        this.#parameters = (parameters === null ? {} : parameters);
        this.#cache = (cache === null ? {} : cache);
        this.changed = false;
    }

    free() {
        utils.freeCache(this.#cache.metrics);
        utils.freeCache(this.#cache.filters);
        utils.freeCache(this.#cache.matrix);
        utils.freeCache(this.#cache.block_buffer);
        utils.freeCache(this.#cache.metrics_buffer);
    }

    /***************************
     ******** Getters **********
     ***************************/
    
    valid() {
        return true;
    }

    fetchSums({ unsafe = false } = {}) {
        // Unsafe, because we're returning a raw view into the Wasm heap,
        // which might be invalidated upon further allocations.
        return this.#cache.metrics.sums({ copy: !unsafe });
    }

    fetchDiscards() {
        return this.#cache.filters.discardOverall({ copy: "view" });
    }

    /***************************
     ******** Compute **********
     ***************************/

    /**
     * This method should not be called directly by users, but is instead invoked by {@linkcode runAnalysis}.
     * Each argument is taken from the property of the same name in the `quality_control` property of the `parameters` of {@linkcode runAnalysis}.
     *
     * @param {boolean} use_mito_default - Whether the internal mitochondrial gene lists should be used.
     * @param {string} mito_prefix - Prefix of the identifiers for mitochondrial genes, when `use_mito_default = false`.
     * @param {number} nmads - Number of MADs to use for automatically selecting the filter threshold for each metric.
     *
     * @return The object is updated with the new results.
     */
    compute(use_mito_default, mito_prefix, nmads) {
        this.changed = false;

        if (this.#inputs.changed || use_mito_default !== this.#parameters.use_mito_default || mito_prefix !== this.#parameters.mito_prefix) {
            var mat = this.#inputs.fetchCountMatrix();

            // TODO: add more choices.
            var nsubsets = 1;
            var subsets = utils.allocateCachedArray(mat.numberOfRows() * nsubsets, "Uint8Array", this.#cache, "metrics_buffer");
            subsets.fill(0);

            // Finding the prefix.
            // TODO: use the guessed features to narrow the Ensembl/symbol search.
            var gene_info = this.#inputs.fetchGenes();
            var sub_arr = subsets.array();
            for (const [key, val] of Object.entries(gene_info)) {
                if (use_mito_default) {
                    val.forEach((x, i) => {
                        if (mito.symbol.has(x) || mito.ensembl.has(x)) {
                            sub_arr[i] = 1;
                        }
                    });
                } else {
                    var lower_mito = mito_prefix.toLowerCase();
                    val.forEach((x, i) => {
                        if(x.toLowerCase().startsWith(lower_mito)) {
                            sub_arr[i] = 1;
                        }
                    });
                }
            }

            utils.freeCache(this.#cache.metrics);
            this.#cache.metrics = scran.computePerCellQCMetrics(mat, [subsets]);

            this.#parameters.use_mito_default = use_mito_default;
            this.#parameters.mito_prefix = mito_prefix;
            this.changed = true;
        }

        if (this.changed || nmads !== this.#parameters.nmads) {
            let block = this.#inputs.fetchBlock();
            utils.freeCache(this.#cache.filters);
            this.#cache.filters = scran.computePerCellQCFilters(this.#cache.metrics, { numberOfMADs: nmads, block: block });

            this.#parameters.nmads = nmads;
            this.changed = true;
        }

        return;
    }

    /***************************
     ******** Results **********
     ***************************/

    #format_metrics({ copy = true } = {}) {
        return {
            sums: this.#cache.metrics.sums({ copy: copy }),
            detected: this.#cache.metrics.detected({ copy: copy }),
            proportion: this.#cache.metrics.subsetProportions(0, { copy: copy })
        };
    }

    #format_thresholds({ copy = true } = {}) {
        return {
            sums: this.#cache.filters.thresholdsSums({ copy: copy }),
            detected: this.#cache.filters.thresholdsDetected({ copy: copy }),
            proportion: this.#cache.filters.thresholdsSubsetProportions(0, { copy: copy })
        }
    }

    /**
     * Obtain a summary of the state, typically for display on a UI like **kana**.
     *
     * @return An object containing:
     *
     * - `data`: an object containing one property for each sample.
     *   Each property is itself an object containing `sums`, `detected` and `proportion`,
     *   which are TypedArrays containing the relevant QC metrics for all cells in that sample.
     * - `thresholds`: an object containing one property for each sample.
     *   Each property is itself an object containing `sums`, `detected` and `proportion`,
     *   which are numbers containing the thresholds on the corresponding QC metrics for that sample.
     * - `retained`: the number of cells remaining after QC filtering.
     */
    summary() {
        var data;
        var blocks = this.#inputs.fetchBlockLevels();
        if (blocks === null) {
            blocks = [ "default" ];
            data = { default: this.#format_metrics() };
        } else {
            let metrics = this.#format_metrics({ copy: "view" });
            let bids = this.#inputs.fetchBlock();
            data = qcutils.splitMetricsByBlock(metrics, blocks, bids);
        }

        let listed = this.#format_thresholds({ copy: "view" });
        let thresholds = qcutils.splitThresholdsByBlock(listed, blocks);

        return { 
            "data": data, 
            "thresholds": thresholds
        };
    }

    /*************************
     ******** Saving *********
     *************************/

    serialize(handle) {
        let ghandle = handle.createGroup("quality_control");

        {
            let phandle = ghandle.createGroup("parameters"); 
            phandle.writeDataSet("use_mito_default", "Uint8", [], Number(this.#parameters.use_mito_default));
            phandle.writeDataSet("mito_prefix", "String", [], this.#parameters.mito_prefix);
            phandle.writeDataSet("nmads", "Float64", [], this.#parameters.nmads);
        }

        {
            let rhandle = ghandle.createGroup("results"); 

            {
                let mhandle = rhandle.createGroup("metrics");
                let data = this.#format_metrics({ copy: "view" });
                mhandle.writeDataSet("sums", "Float64", null, data.sums)
                mhandle.writeDataSet("detected", "Int32", null, data.detected);
                mhandle.writeDataSet("proportion", "Float64", null, data.proportion);
            }

            {
                let thandle = rhandle.createGroup("thresholds");
                let thresholds = this.#format_thresholds({ copy: "hdf5" }); 
                for (const x of [ "sums", "detected", "proportion" ]) {
                    let current = thresholds[x];
                    thandle.writeDataSet(x, "Float64", null, current);
                }
            }

            let disc = this.fetchDiscards();
            rhandle.writeDataSet("discards", "Uint8", null, disc);
        }
    }
}

/**************************
 ******** Loading *********
 **************************/

class QCFiltersMimic {
    constructor(sums, detected, proportion, discards) {
        this.sums_ = sums;
        this.detected_ = detected;
        this.proportion_ = proportion;
        this.discards = scran.createUint8WasmArray(discards.length);
        this.discards.set(discards);
    }

    thresholdsSums({ copy }) {
        return utils.mimicGetter(this.sums_, copy);
    }

    thresholdsDetected({ copy }) {
        return utils.mimicGetter(this.detected_, copy);
    }

    thresholdsSubsetProportions(index, { copy }) {
        if (index != 0) {
            throw "only 'index = 0' is supported for mimics";
        }
        return utils.mimicGetter(this.proportion_, copy);
    }

    discardOverall({ copy }) {
        return utils.mimicGetter(this.discards, copy);
    }

    free() {
        this.discards.free();
    }
}

export function unserialize(handle, inputs) {
    let ghandle = handle.open("quality_control");

    let parameters = {};
    {
        let phandle = ghandle.open("parameters"); 
        parameters = {
            use_mito_default: phandle.open("use_mito_default", { load: true }).values[0] > 0,
            mito_prefix: phandle.open("mito_prefix", { load: true }).values[0],
            nmads: phandle.open("nmads", { load: true }).values[0]
        }
    }

    let cache = {};
    {
        let rhandle = ghandle.open("results");

        let mhandle = rhandle.open("metrics");
        let sums = mhandle.open("sums", { load: true }).values;

        cache.metrics = scran.emptyPerCellQCMetricsResults(sums.length, 1);
        cache.metrics.sums({ copy: false }).set(sums);

        let detected = mhandle.open("detected", { load: true }).values;
        cache.metrics.detected({ copy: false }).set(detected);
        let proportions = mhandle.open("proportion", { load: true }).values;
        cache.metrics.subsetProportions(0, { copy: false }).set(proportions);

        let thandle = rhandle.open("thresholds");
        let thresholds_sums = thandle.open("sums", { load: true }).values;
        let thresholds_detected = thandle.open("detected", { load: true }).values;
        let thresholds_proportion = thandle.open("proportion", { load: true }).values;

        let discards = rhandle.open("discards", { load: true }).values; 
        cache.filters = new QCFiltersMimic(
            thresholds_sums, 
            thresholds_detected,
            thresholds_proportion,
            discards
        );
    }

    return {
        state: new QualityControlState(inputs, parameters, cache),
        parameters: { ...parameters }
    };
}
