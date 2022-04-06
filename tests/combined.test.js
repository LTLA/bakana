import * as bakana from "../src/index.js";
import * as scran from "scran.js";
import * as utils from "./utils.js"

beforeAll(async () => await bakana.initialize({ localFile: true }));
afterAll(async () => await bakana.terminate());

test("multi-matrix analyses work correctly", async () => {
    let contents = {};
    let finished = (step, res) => {
        contents[step] = res;
    };

    let paramcopy = utils.baseParams();
    let state = await bakana.createAnalysis();
    let res = await bakana.runAnalysis(
        state,
        { 
            "4K": {
                format: "10X",
                h5: "files/datasets/pbmc4k-tenx.h5"
            },
            "3K": {
                format: "MatrixMarket",
                mtx: "files/datasets/pbmc3k-matrix.mtx.gz",
                genes: "files/datasets/pbmc3k-features.tsv.gz",
                annotations: "files/datasets/pbmc3k-barcodes.tsv.gz"
            }
        },
        paramcopy,
        {
            finishFun: finished,
        }
    );

    expect(contents.quality_control instanceof Object).toBe(true);
    expect("3K" in contents.quality_control.thresholds).toBe(true);
    expect("4K" in contents.quality_control.thresholds).toBe(true);

    // Saving and loading.
    const path = "TEST_state_multi-matrix.h5";
    let collected = await bakana.saveAnalysis(state, path);
    expect(collected.collected.length).toBe(4);
    expect(typeof(collected.collected[0])).toBe("string");
    
    let offsets = utils.mockOffsets(collected.collected);
    let reloaded = await bakana.loadAnalysis(
        path, 
        (offset, size) => offsets[offset]
    );

    let new_params = reloaded.parameters;
    expect(new_params.quality_control instanceof Object).toBe(true);
    expect(new_params.pca instanceof Object).toBe(true);

    // Freeing.
    bakana.freeAnalysis(state);
})

test("single-matrix multi-sample analyses work correctly", async () => {
    let contents = {};
    let finished = (step, res) => {
        contents[step] = res;
    };
    
    let paramcopy = utils.baseParams();
    paramcopy.inputs = {
        sample_factor: "3k"
    };
    let state = await bakana.createAnalysis();
    let res = await bakana.runAnalysis(
        state,
        { 
            "combined": {
                format: "MatrixMarket",
                mtx: "files/datasets/pbmc-combined-matrix.mtx.gz",
                genes: "files/datasets/pbmc-combined-features.tsv.gz",
                annotations: "files/datasets/pbmc-combined-barcodes.tsv.gz"
            }
        },
        paramcopy,
        {
            finishFun: finished,
        }
    );

    expect(contents.quality_control instanceof Object).toBe(true);
    expect("3k" in contents.quality_control.thresholds).toBe(true);
    expect("4k" in contents.quality_control.thresholds).toBe(true);

    // Saving and loading.
    const path = "TEST_state_multi-matrix.h5";
    let collected = await bakana.saveAnalysis(state, path);
    expect(collected.collected.length).toBe(3);
    expect(typeof(collected.collected[0])).toBe("string");
    
    let offsets = utils.mockOffsets(collected.collected);
    let reloaded = await bakana.loadAnalysis(
        path, 
        (offset, size) => offsets[offset]
    );

    let new_params = reloaded.parameters;
    expect(new_params.quality_control instanceof Object).toBe(true);
    expect(new_params.pca instanceof Object).toBe(true);

    // Freeing.
    bakana.freeAnalysis(state);
})
