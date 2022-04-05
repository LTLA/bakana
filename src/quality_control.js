import * as scran from "scran.js"; 
import * as utils from "./utils/general.js";
import { mito } from "./mito.js";
import * as inputs_module from "./inputs.js";

export class State {
    #inputs;
    #cache;
    #parameters;

    constructor(inputs, parameters = null, cache = null) {
        if (!(inputs instanceof inputs_module.State)) {
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

    fetchSums({ unsafe = false } = {}) {
        // Unsafe, because we're returning a raw view into the Wasm heap,
        // which might be invalidated upon further allocations.
        return this.#cache.metrics.sums({ copy: !unsafe });
    }

    fetchDiscards() {
        return this.#cache.filters.discardOverall({ copy: "view" });
    }

    fetchFilteredMatrix() {
        if (!("matrix" in this.#cache)) {
            this.#apply_filters();
        }
        return this.#cache.matrix;
    }

    fetchFilteredBlock() {
        if (!("blocked" in this.#cache)) {
            this.#apply_filters();
        }
        if (this.#cache.blocked) {
            return this.#cache.block_buffer;
        } else {
            return null;
        }
    }

    /***************************
     ******** Compute **********
     ***************************/

    #apply_filters() {
        var mat = this.#inputs.fetchCountMatrix();
        var disc = this.fetchDiscards();

        utils.freeCache(this.#cache.matrix);
        this.#cache.matrix = scran.filterCells(mat, disc);

        let block = this.#inputs.fetchBlock();
        this.#cache.blocked = (block !== null);

        if (this.#cache.blocked) {
            let bcache = utils.allocateCachedArray(this.#cache.matrix.numberOfColumns(), "Int32Array", this.#cache, "block_buffer");

            let bcache_arr = bcache.array();
            let block_arr = block.array();
            let disc_arr = disc.array();
            let j = 0;
            for (let i = 0; i < block_arr.length; i++) {
                if (disc_arr[i] == 0) {
                    bcache_arr[j] = block_arr[i];
                    j++;
                }
            }
        }

        return;
    }

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
            this.#cache.metrics = scran.computePerCellQCMetrics(mat, subsets);

            this.#parameters.use_mito_default = use_mito_default;
            this.#parameters.mito_prefix = mito_prefix;
            this.changed = true;
        }

        if (changed || nmads !== this.#parameters.nmads) {
            let block = this.#inputs.fetchBlock();
            utils.freeCache(this.#cache.filters);
            this.#cache.filters = scran.computePerCellQCFilters(this.#cache.metrics, { numberOfMADs: nmads, block: block });

            this.#parameters.nmads = nmads;
            this.changed = true;
        }

        if (changed) {
            this.#apply_filters();
            this.changed = true;
        }

        return;
    }

    /***************************
     ******** Results **********
     ***************************/

    #format_metrics({ copy = true } = {}) {
        copy = (copy ? true : "view");
        return {
            sums: this.#cache.metrics.sums({ copy: copy }),
            detected: this.#cache.metrics.detected({ copy: copy }),
            proportion: this.#cache.metrics.subsetProportions(0, { copy: copy })
        };
    }

    #format_thresholds({ copy = true } = {}) {
        copy = (copy ? true : "view");
        return {
            sums: this.#cache.filters.thresholdsSums({ copy: copy }),
            detected: this.#cache.filters.thresholdsDetected({ copy: copy }),
            proportion: this.#cache.filters.thresholdsSubsetProportions(0, { copy: copy })
        }
    }

    results() {
        // This function should not do any Wasm allocations, so copy: false is safe.

        var data = {};
        var blocks = this.#inputs.fetchBlockLevels();
        if (blocks === null) {
            blocks = [ "default" ];
            data["default"] = this.#format_metrics();
        } else {
            let metrics = this.#format_metrics({ copy: false });
            let bids = this.#inputs.fetchBlock();
            let barray = bids.array();

            for (var b = 0; b < blocks.length; b++) {
                let current = {};
                for (const [key, val] of Object.entries(metrics)) {
                    current[key] = val.array().filter((x, i) => barray[i] == b);
                }
                data[blocks[b]] = current;
            }
        }

        var thresholds = {};
        let listed = this.#format_thresholds({ copy: false });
        for (var b = 0; b < blocks.length; b++) {
            let current = {};
            for (const [key, val] of Object.entries(listed)) {
                current[key] = val[b];
            }
            thresholds[blocks[b]] = current;
        }

        var ranges = {};
        for (var b = 0; b < blocks.length; b++) {
            let curranges = {};
            let curdata = data[blocks[b]];

            for (const [key, val] of Object.entries(curdata)) {
                var max = -Infinity, min = Infinity;
                val.forEach(function (x) {
                    if (max < x) {
                        max = x;
                    }
                    if (min > x) {
                        min = x;
                    }
                });
                curranges[key] = [min, max];
            }

            ranges[blocks[b]] = curranges;
        }

        let remaining = 0;
        if ("matrix" in cache) {
            remaining = this.#cache.matrix.numberOfColumns();
        } else {
            this.fetchDiscards().array().forEach(x => {
                if (x == 0) {
                    remaining++;
                }
            });
        }

        return { 
            "data": data, 
            "ranges": ranges,
            "thresholds": thresholds,
            "retained": remaining
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
                let data = this.#format_metrics({ copy: false });
                mhandle.writeDataSet("sums", "Float64", null, data.sums)
                mhandle.writeDataSet("detected", "Int32", null, data.detected);
                mhandle.writeDataSet("proportion", "Float64", null, data.proportion);
            }

            {
                let thandle = rhandle.createGroup("thresholds");
                let thresholds = this.#format_thresholds({ copy: false });
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
        state: new State(inputs, parameters, cache),
        parameters: { ...parameters }
    };
}
