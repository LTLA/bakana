import * as scran from "scran.js";

import * as inputs from "./steps/inputs.js";

import * as qc from "./steps/quality_control.js";
import * as qcadt from "./steps/adt_quality_control.js";
import * as filters from "./steps/cell_filtering.js";

import * as normalization from "./steps/normalization.js";
import * as normadt from "./steps/adt_normalization.js";

import * as variance from "./steps/feature_selection.js";

import * as pca from "./steps/pca.js";
import * as pcaadt from "./steps/adt_pca.js";
import * as combine from "./steps/combine_embeddings.js";
import * as correct from "./steps/batch_correction.js";

import * as index from "./steps/neighbor_index.js";
import * as cluster_choice from "./steps/choose_clustering.js";
import * as kmeans_cluster from "./steps/kmeans_cluster.js";
import * as snn_cluster from "./steps/snn_graph_cluster.js";

import * as tsne from "./steps/tsne.js";
import * as umap from "./steps/umap.js";

import * as cluster_markers from "./steps/marker_detection.js";
import * as label_cells from "./steps/cell_labelling.js";
import * as custom_markers from "./steps/custom_selections.js";

const step_inputs = inputs.step_name;
const step_qc = qc.step_name;
const step_qc_adt = qcadt.step_name;
const step_filter = filters.step_name;
const step_norm = normalization.step_name;
const step_norm_adt = normadt.step_name;
const step_feat = "feature_selection";
const step_pca = pca.step_name;
const step_pca_adt = pcaadt.step_name;
const step_combine = "combine_embeddings";
const step_correct = "batch_correction";
const step_neighbors = index.step_name;
const step_tsne = "tsne";
const step_umap = "umap";
const step_kmeans = "kmeans_cluster";
const step_snn = "snn_graph_cluster";
const step_choice = "choose_clustering";
const step_markers = cluster_markers.step_name;
const step_labels = "cell_labelling";
const step_custom = custom_markers.step_name;

/**
 * Create a new analysis state in preparation for calling {@linkcode runAnalysis}.
 * Multiple states can be created and used interchangeably within the same Javascript runtime.
 *
 * @return A promise that resolves to an object containing states for all analysis steps.
 * This object can be used as input into {@linkcode runAnalysis}.
 */
export async function createAnalysis() {
    return create_analysis(new inputs.InputsState);
}

function create_analysis(input_state) {
    let output = {};
    output[step_inputs] = input_state;

    output[step_qc] = new qc.QualityControlState(output[step_inputs]);
    output[step_qc_adt] = new qcadt.AdtQualityControlState(output[step_inputs]);
    output[step_filter] = new filters.CellFilteringState(output[step_inputs], { "RNA": output[step_qc], "ADT": output[step_qc_adt] });

    output[step_norm] = new normalization.NormalizationState(output[step_qc], output[step_filter]);
    output[step_norm_adt] = new normadt.AdtNormalizationState(output[step_qc_adt], output[step_filter]);

    output[step_feat] = new variance.FeatureSelectionState(output[step_filter], output[step_norm]);

    output[step_pca] = new pca.PcaState(output[step_filter], output[step_norm], output[step_feat]);
    output[step_pca_adt] = new pcaadt.AdtPcaState(output[step_filter], output[step_norm_adt]);
    output[step_combine] = new combine.CombineEmbeddingsState({ "RNA": output[step_pca], "ADT": output[step_pca_adt] });
    output[step_correct] = new correct.BatchCorrectionState(output[step_filter], output[step_combine]);

    output[step_neighbors] = new index.NeighborIndexState(output[step_correct]);

    output[step_tsne] = new tsne.TsneState(output[step_neighbors]);
    output[step_umap] = new umap.UmapState(output[step_neighbors]);

    output[step_kmeans] = new kmeans_cluster.KmeansClusterState(output[step_correct]);
    output[step_snn] = new snn_cluster.SnnGraphClusterState(output[step_neighbors]);
    output[step_choice] = new cluster_choice.ChooseClusteringState(output[step_snn], output[step_kmeans]);

    let norm_states = { "RNA": output[step_norm], "ADT": output[step_norm_adt] };
    output[step_markers] = new cluster_markers.MarkerDetectionState(output[step_filter], norm_states, output[step_choice]);
    output[step_labels] = new label_cells.CellLabellingState(output[step_inputs], output[step_markers]);
    output[step_custom] = new custom_markers.CustomSelectionsState(output[step_filter], norm_states);

    return Promise.all([output[step_tsne].ready(), output[step_umap].ready()]).then(val => output);
}

/**
 * Free the contents of an analysis state.
 * This releases memory on the **scran.js** Wasm heap and terminates any workers associated with this analysis.
 *
 * @param state An existing analysis state, produced by {@linkcode createAnalysis} or {@linkcode loadAnalysis}.
 *
 * @return A promise that resolves to `null` when all states are freed.
 */
export function freeAnalysis(state) {
    let promises = [];
    for (const [k, v] of Object.entries(state)) {
        let p = v.free();
        if (p) { // not null, not undefined.
            promises.push(p); 
        }
    }
    return Promise.all(promises).then(x => null);
}

/**
 * Run a basic single-cell RNA-seq analysis with the specified files and parameters.
 * This will cache the results from each step so that, if the parameters change, only the affected steps will be rerun.
 *
 * @param {object} state - Object containing the analysis state, produced by {@linkcode createAnalysis} or {@linkcode loadAnalysis}.
 * @param {Array} matrices - Object where each (arbitrarily named) property corresponds to an input matrix. 
 * Each matrix should be an object with `type` string property and any number of additional properties referring to individual data files.
 *
 * - If `type: "MatrixMarket"`, the object should contain an `mtx` property, referring to a (possibly Gzipped) Matrix Market file containing a count matrix.
 *   The object may contain a `genes` property, referring to a (possibly Gzipped) tab-separated file with the gene ID and symbols for each row of the count matrix.
 *   The object may contain a `annotation` property, referring to a (possibly Gzipped) tab-separated file with the gene ID and symbols for each row of the count matrix.
 * - If `type: "10X"`, the object should contain an `h5` property, referring to a HDF5 file following the 10X Genomics feature-barcode matrix format.
 *   It is assumed that the matrix has already been filtered to contain only the cell barcodes.
 * - If `type: "H5AD"`, the object should contain an `h5` property, referring to a H5AD file.
 *
 * The representation of each reference to a data file depends on the runtime.
 * In the browser, each data file manifests as a `File` object; for Node.js, each data file should be represented as a string containing a file path.
 *
 * Alternatively, `matrices` may be `null`, in which case the count matrices are extracted from `state`.
 * This assumes that the data matrices were already cached in `state`, either from a previous call to {@linkcode runAnalysis} or from @{linkcode loadAnalysis}.
 * @param {object} params - An object containing parameters for all steps.
 * See {@linkcode analysisDefaults} for more details.
 * @param {object} [options] - Optional parameters.
 * @param {function} [options.startFun] - Function that is called when each step is started.
 * This should accept a single argument - the name of the step.
 * If `null`, nothing is executed.
 * @param {function} [options.finishFun] - Function that is called on successful execution of each step.
 * This should accept two arguments - the name of the step and an object containing the results of that step.
 * (The latter will be undefined if the step uses a previously cached result.)
 * If `null`, nothing is executed.
 * 
 * @return A promise that resolves to `null` when all asynchronous analysis steps are complete.
 * The contents of `state` are modified by reference to reflect the latest state of the analysis with the supplied parameters.
 */
export async function runAnalysis(state, matrices, params, { startFun = null, finishFun = null } = {}) {
    let quickStart = step => {
        if (startFun !== null) {
            startFun(step);
        }
    }

    let quickFinish = step => {
        if (finishFun !== null) {
            if (state[step].changed) {
                finishFun(step, state[step].summary());
            } else {
                finishFun(step);
            }
        }
    }

    let promises = [];
    let asyncQuickFinish = (step, p) => {
        if (finishFun !== null) {
            if (state[step].changed) {
                p = state[step].summary().then(res => finishFun(step, res));
            } else {
                p = p.then(out => finishFun(step));
            }
        }
        promises.push(p);
    }

    /*** Loading ***/
    quickStart(step_inputs);
    await state[step_inputs].compute(
        matrices, 
        params[step_inputs]["sample_factor"],
        params[step_inputs]["subset"]
    );
    quickFinish(step_inputs);

    /*** Quality control ***/
    quickStart(step_qc);
    state[step_qc].compute(
        params[step_qc]["skip"],
        params[step_qc]["use_mito_default"], 
        params[step_qc]["mito_prefix"], 
        params[step_qc]["nmads"]
    );
    quickFinish(step_qc);

    quickStart(step_qc_adt);
    state[step_qc_adt].compute(
        params[step_qc_adt]["skip"],
        params[step_qc_adt]["igg_prefix"], 
        params[step_qc_adt]["nmads"],
        params[step_qc_adt]["min_detected_drop"]
    );
    quickFinish(step_qc_adt);

    quickStart(step_filter);
    state[step_filter].compute();
    quickFinish(step_filter);

    /*** Normalization ***/
    quickStart(step_norm);
    state[step_norm].compute();
    quickFinish(step_norm);

    quickStart(step_norm_adt);
    state[step_norm_adt].compute(
        params[step_norm_adt]["num_pcs"],    
        params[step_norm_adt]["num_clusters"]    
    );
    quickFinish(step_norm_adt);

    /*** Feature selection ***/
    quickStart(step_feat);
    state[step_feat].compute(
        params[step_feat]["span"]
    );
    quickFinish(step_feat);
  
    /*** Dimensionality reduction ***/
    quickStart(step_pca);
    state[step_pca].compute(
        params[step_pca]["num_hvgs"],
        params[step_pca]["num_pcs"],
        params[step_pca]["block_method"]
    );
    quickFinish(step_pca);

    quickStart(step_pca_adt);
    state[step_pca_adt].compute(
        params[step_pca_adt]["num_pcs"],
        params[step_pca_adt]["block_method"]
    );
    quickFinish(step_pca_adt);

    quickStart(step_combine);
    state[step_combine].compute(
        params[step_combine]["weights"],
        params[step_combine]["approximate"]
    );
    quickFinish(step_combine);

    quickStart(step_correct);
    state[step_correct].compute(
        params[step_correct]["method"],
        params[step_correct]["num_neighbors"],
        params[step_correct]["approximate"]
    );
    quickFinish(step_correct);

    /*** Nearest neighbors ***/
    quickStart(step_neighbors);
    state[step_neighbors].compute(
        params[step_neighbors]["approximate"]
    );
    quickFinish(step_neighbors);

    /*** Visualization ***/
    {
        quickStart(step_tsne);
        let p = state[step_tsne].compute(
            params[step_tsne]["perplexity"],
            params[step_tsne]["iterations"], 
            params[step_tsne]["animate"]
        );
        asyncQuickFinish(step_tsne, p);
    }

    {
        quickStart(step_umap);
        let p = state[step_umap].compute(
            params[step_umap]["num_neighbors"], 
            params[step_umap]["num_epochs"], 
            params[step_umap]["min_dist"], 
            params[step_umap]["animate"]
        );
        asyncQuickFinish(step_umap, p);
    }

    /*** Clustering ***/
    let method = params[step_choice]["method"];

    quickStart(step_kmeans);
    state[step_kmeans].compute(
        method == "kmeans", 
        params[step_kmeans]["k"]
    );
    quickFinish(step_kmeans);

    quickStart(step_snn);
    state[step_snn].compute(
        method == "snn_graph", 
        params[step_snn]["k"], 
        params[step_snn]["scheme"], 
        params[step_snn]["resolution"]
    );
    quickFinish(step_snn);

    quickStart(step_choice);
    state[step_choice].compute(
        method
    );
    quickFinish(step_choice);

    /*** Markers and labels ***/
    quickStart(step_markers);
    state[step_markers].compute();
    quickFinish(step_markers);

    {
        quickStart(step_labels);
        let p = state[step_labels].compute(
            params[step_labels]["human_references"],
            params[step_labels]["mouse_references"]
        );
        asyncQuickFinish(step_labels, p);
    }

    state[step_custom].compute();
    quickFinish(step_custom);

    await Promise.all(promises);
    return null;
}

/**
 * Save the current analysis state into a HDF5 file.
 * This HDF5 file can then be embedded into a `*.kana` file for distribution.
 *
 * @param {object} state - Object containing the analysis state, produced by {@linkcode createAnalysis} or {@linkcode loadAnalysis}.
 * If produced by {@linkcode createAnalysis}, it should have been run through {@linkcode runAnalysis} beforehand.
 * @param {string} path - Path to the output HDF5 file.
 * On browsers, this will lie inside the virtual file system of the **scran.js** module.
 * @param {object} [options] - Optional parameters.
 * @param {boolean} [options.embedded] - Whether to store information for embedded data files.
 * If `false`, links to data files are stored instead, see {@linkcode setCreateLink}.
 * 
 * @return A HDF5 file is created at `path` containing the analysis parameters and results - see https://ltla.github.io/kanaval for more details on the structure.
 * If `embedded = false`, a promise is returned that resolves to `null` when the saving is complete.
 * Otherwise, an object is returned containing:
 * - `collected`: an array of length equal to the number of data files.
 *   If `linkFun: null`, each element is an ArrayBuffer containing the file contents, which can be used to assemble an embedded `*.kana` file.
 *   Otherwise, if `linkFun` is supplied, each element is a string containing the linking identifier to the corresponding file.
 * - `total`: an integer containing the total length of all ArrayBuffers in `collected`.
 *   This will only be present if `linkFun` is not supplied.
 */
export async function saveAnalysis(state, path, { embedded = true } = {}) {
    let saver = null;
    let saved = null;

    if (embedded) {
        saved = { collected: [], total: 0 };
        saver = (serialized, size) => {
            saved.collected.push(serialized);
            let current = saved.total;
            saved.total += size;
            return {
                "offset": current,
                "size": size
            };
        };
    }

    let handle = scran.createNewHDF5File(path);

    /*** Loading ***/
    await state[step_inputs].serialize(handle, saver);

    /*** Quality control ***/
    state[step_qc].serialize(handle);
    state[step_qc_adt].serialize(handle);
    state[step_filter].serialize(handle);

    /*** Normalization ***/
    state[step_norm].serialize(handle);
    state[step_norm_adt].serialize(handle);

    /*** Feature selection ***/
    state[step_feat].serialize(handle);

    /*** Dimensionality reduction ***/
    state[step_pca].serialize(handle);
    state[step_pca_adt].serialize(handle);
    state[step_combine].serialize(handle);
    state[step_correct].serialize(handle);

    /*** Nearest neighbors ***/
    state[step_neighbors].serialize(handle);

    /*** Visualization ***/
    await state[step_tsne].serialize(handle);
    await state[step_umap].serialize(handle);

    /*** Clustering ***/
    state[step_kmeans].serialize(handle);
    state[step_snn].serialize(handle);
    state[step_choice].serialize(handle);

    /*** Markers and labels ***/
    state[step_markers].serialize(handle);
    await state[step_labels].serialize(handle);
    state[step_custom].serialize(handle);

    return saved;
}

/**
 * Load an analysis state from a HDF5 state file, usually excised from a `*.kana` file.
 *
 * @param {string} path - Path to the HDF5 file containing the analysis state.
 * On browsers, this should lie inside the virtual file system of the **scran.js** module.
 * @param {function} loadFun - Function to load each embedded data file.
 * This should accept two arguments - an offset to the start of the file in the embedded file buffer, and the size of the file.
 *
 * In the browser, the function should return an ArrayBuffer containing the contents of the file.
 * For Node.js, the function should return a string containing a path to the file.
 * In both cases, the function may instead return a promise that resolves to the expected values.
 *
 * Note that this function is only used if the state file at `path` contains information for embedded files; 
 * otherwise, links are resolved using reader-specific functions (see {@linkcode setResolveLink} for the common use cases).
 * @param {object} [options] - Optional parameters.
 * @param {function} [options.finishFun] - Function that is called on after extracting results for each step.
 * This should accept two arguments - the name of the step and an object containing the results of that step.
 * If `null`, a no-op function is automatically created.
 *
 * @return An object containing the loaded analysis state.
 * This is conceptually equivalent to creating a state with {@linkcode createAnalysis} and running it through {@linkcode runAnalysis}.
 */
export async function loadAnalysis(path, loadFun, { finishFun = null } = {}) {
    let state = {};
    let handle = new scran.H5File(path);
    let quickFun = step => {
        if (finishFun !== null) {
            finishFun(step, state[step].summary());
        }
    }

    /*** Loading ***/
    let permuters;
    {
        let out = await inputs.unserialize(handle, loadFun);
        state[step_inputs] = out.state;
        permuters = out.permuters;
        quickFun(step_inputs);
    }

    /*** Quality control ***/
    {
        state[step_qc] = qc.unserialize(handle, state[step_inputs]);
        quickFun(step_qc);
    }

    {
        state[step_qc_adt] = qcadt.unserialize(handle, state[step_inputs]);
        quickFun(step_qc_adt);
    }

    {
        state[step_filter] = filters.unserialize(handle, state[step_inputs], { "RNA": state[step_qc], "ADT": state[step_qc_adt] });
        quickFun(step_filter);
    }

    /*** Normalization ***/
    {
        state[step_norm] = normalization.unserialize(handle, state[step_qc], state[step_filter]);
        quickFun(step_norm);
    }

    {
        state[step_norm_adt] = normadt.unserialize(handle, state[step_qc_adt], state[step_filter]);
        quickFun(step_norm_adt);
    }

    /*** Feature selection ***/
    {
        state[step_feat] = variance.unserialize(handle, permuters["RNA"], state[step_filter], state[step_norm]);
        quickFun(step_feat);
    }

    /*** Dimensionality reduction ***/
    {
        state[step_pca] = pca.unserialize(handle, state[step_filter], state[step_norm], state[step_feat]);
        quickFun(step_pca);
    }

    {
        state[step_pca_adt] = pcaadt.unserialize(handle, state[step_filter], state[step_norm_adt]);
        quickFun(step_pca_adt);
    }

    {
        state[step_combine] = combine.unserialize(handle, { "RNA": state[step_pca], "ADT": state[step_pca_adt] });
        quickFun(step_combine);
    }

    {
        state[step_correct] = correct.unserialize(handle, state[step_filter], state[step_combine]);
        quickFun(step_correct);
    }

    /*** Nearest neighbors ***/
    {
        state[step_neighbors] = index.unserialize(handle, state[step_correct]);
        quickFun(step_neighbors);
    }

    /*** Visualization ***/
    // Note that all awaits here are trivial, and just occur because summary()
    // is async for general usage.  So we can chuck them in without really
    // worrying that they're blocking anything here.
    {
        state[step_tsne] = tsne.unserialize(handle, state[step_neighbors]);
        if (finishFun !== null) {
            finishFun(step_tsne, await state[step_tsne].summary());
        }
    }

    {
        state[step_umap] = umap.unserialize(handle, state[step_neighbors]);
        if (finishFun !== null) {
            finishFun(step_umap, await state[step_umap].summary());
        }
    }

    /*** Clustering ***/
    {
        state[step_kmeans] = kmeans_cluster.unserialize(handle, state[step_correct]);
        quickFun(step_kmeans);
    }

    {
        state[step_snn] = snn_cluster.unserialize(handle, state[step_neighbors]);
        quickFun(step_snn);
    }

    {
        state[step_choice] = cluster_choice.unserialize(handle, state[step_snn], state[step_kmeans]);
        quickFun(step_choice);
    }

    /*** Markers and labels ***/
    let norm_states = { "RNA": state[step_norm], "ADT": state[step_norm_adt] };
    {
        state[step_markers] = cluster_markers.unserialize(handle, permuters, state[step_filter], norm_states, state[step_choice]);
        quickFun(step_markers);
    }

    {
        state[step_labels] = label_cells.unserialize(handle, state[step_inputs], state[step_markers]);
        if (finishFun !== null) {
            finishFun(step_labels, await state[step_labels].summary());
        }
    }

    {
        state[step_custom] = custom_markers.unserialize(handle, permuters, state[step_filter], norm_states);
        quickFun(step_custom);
    }

    return state;
}

/**
 * Retrieve analysis parameters from a state object.
 *
 * @param {object} state - Object containing the analysis state, produced by {@linkcode createAnalysis} or {@linkcode loadAnalysis}.
 *
 * @return {object} Object containing the analysis parameters for each step, similar to that created by {@linkcode analysisDefaults}.
 */
export function retrieveParameters(state) {
    let params = {};
    for (const [k, v] of Object.entries(state)) {
        params[k] = v.fetchParameters();
    }
    return params;
}

/**
 * Create a new analysis state object consisting of a subset of cells from an existing analysis state.
 * This assumes that the existing state already contains loaded matrix data in its `inputs` property,
 * which allows us to create a cheap reference without reloading the data into memory.
 *
 * @param {object} state - State object such as that produced by {@linkcode createAnalysis} or {@linkcode linkAnalysis}.
 * This should already contain loaded data, e.g., after a run of {@linkcode runAnalysis}.
 * @param {TypedArray|Array} indices - Array containing the indices for the desired subset of cells.
 * This should be sorted and non-duplicate.
 * Any existing subset in `state` will be overridden by `indices`.
 * @param {object} [options] - Optional parameters.
 * @param {boolean} [options.copy=true] - Whether to make a copy of `indices` before storing it inside the returned state object.
 * If `false`, it is assumed that the caller makes no further use of the passed `indices`.
 * @param {boolean} [options.onOriginal=false] - Whether `indices` contains indices on the original dataset or on the dataset in `state`.
 * This distinction is only relevant if `state` itself contains an analysis of a subsetted dataset.
 * If `false`, the `indices` are assumed to refer to the columns of the already-subsetted dataset that exists in `state`;
 * if `true`, the `indices` are assumed to refer to the columns of the original dataset from which the subset in `state` was created.
 *
 * @return {object} A state object containing loaded matrix data in its `inputs` property.
 * Note that the other steps do not have any results, so this object should be passed through {@linkcode runAnalysis} before it can be used.
 */
export async function subsetInputs(state, indices, { copy = true, onOriginal = false } = {}) {
    return create_analysis(state.inputs.createDirectSubset(indices, { copy: copy, onOriginal: onOriginal }));
}
