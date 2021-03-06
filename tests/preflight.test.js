import * as bakana from "../src/index.js";
import * as scran from "scran.js";
import * as utils from "./utils.js";

beforeAll(async () => await bakana.initialize({ localFile: true }));
afterAll(async () => await bakana.terminate());

test("annotation preflight works correctly (one file)", async () => {
    let res = await bakana.validateAnnotations(
        {
            default: {
                format: "MatrixMarket",
                mtx: "files/datasets/pbmc3k-matrix.mtx.gz",
                genes: "files/datasets/pbmc3k-features.tsv.gz",
                annotations: "files/datasets/pbmc3k-barcodes.tsv.gz"
            }
        }
    );

    expect(res.features.RNA.common).toBeGreaterThan(0);
    expect(typeof res.features.RNA.fields.default).toBe("string");

    let default_anno = res.annotations.default;
    let default_keys = Object.keys(default_anno);
    expect(default_keys.length).toBeGreaterThan(0);
    
    let first = default_anno[default_keys[0]];
    expect(first.values.length).toBeGreaterThan(0);
    expect(first.truncated).toBe(true); // as these are just the cell names, so they'll be cut off.

    // still works without any annotations.
    let res2 = await bakana.validateAnnotations(
        {
            default: {
                format: "MatrixMarket",
                mtx: "files/datasets/pbmc3k-matrix.mtx.gz"
            }
        }
    );

    expect(res2.annotations.default).toBeNull();
    expect(res2.features.RNA.common).toBeNull();
})

test("annotation preflight works correctly (two files)", async () => {
    let res = await bakana.validateAnnotations(
        {
            "3k": {
                format: "MatrixMarket",
                mtx: "files/datasets/pbmc3k-matrix.mtx.gz",
                genes: "files/datasets/pbmc3k-features.tsv.gz",
                annotations: "files/datasets/pbmc3k-barcodes.tsv.gz"
            },
            "4k": {
                format: "10X",
                h5: "files/datasets/pbmc4k-tenx.h5"
            }
        }
    );

    expect(res.features.RNA.common).toBeGreaterThan(30000);
    expect(res.features.RNA.fields["3k"]).toBe("id");
    expect(res.features.RNA.fields["4k"]).toBe("id");

    // Checking the annotations while we're here.
    expect(Object.keys(res.annotations["3k"]).length).toBeGreaterThan(0);
    expect(res.annotations["4k"]).toBeNull();
})

test("annotation preflight works correctly for H5ADs", async () => {
    let res = await bakana.validateAnnotations(
        {
            "brain": {
                format: "H5AD",
                h5: "files/datasets/zeisel-brain.h5ad"
            }
        }
    );

    let brain_anno = res.annotations.brain;
    let brain_keys = Object.keys(brain_anno);
    expect(brain_keys.length).toBeGreaterThan(0);
    
    let cells = brain_anno["cell_id"];
    expect(cells.values.length).toBeGreaterThan(0);
    expect(typeof cells.values[0]).toBe("string");
    expect(cells.truncated).toBe(true); 

    let sex = brain_anno["sex"];
    expect(sex.min).toBe(1);
    expect(sex.max).toBe(3);
})

test("annotation preflight fails correctly (two files, wrong species)", async () => {
    let res;
    let err;
    try {
        res = await bakana.validateAnnotations(
            {
                "brain": {
                    format: "H5AD",
                    h5: "files/datasets/zeisel-brain.h5ad"
                },
                "4k": {
                    format: "10X",
                    h5: "files/datasets/pbmc4k-tenx.h5"
                }
            }
        );
    } catch (e) {
        err = e.toString();
    }

    expect(res).toBeUndefined();
    expect(err).toMatch("common feature type");
})

test("annotation preflight fails correctly (two files, no genes)", async () => {
    let res;
    let err;
    try {
        res = await bakana.validateAnnotations(
            {
                "brain": {
                    format: "H5AD",
                    h5: "files/datasets/zeisel-brain.h5ad"
                },
                "3k": {
                    format: "MatrixMarket",
                    mtx: "files/datasets/pbmc3k-matrix.mtx.gz"
                }
            }
        );
    } catch (e) {
        err = e.toString();
    }

    expect(res).toBeUndefined();
    expect(err).toMatch("gene annotations");
})

test("annotation preflight works correctly (ADTs)", async () => {
    let res = await bakana.validateAnnotations(
        {
            default: {
                format: "MatrixMarket",
                mtx: "files/datasets/immune_3.0.0-matrix.mtx.gz",
                genes: "files/datasets/immune_3.0.0-features.tsv.gz",
                annotations: "files/datasets/immune_3.0.0-barcodes.tsv.gz"
            }
        }
    );

    expect(Object.keys(res.annotations.default).length).toBeGreaterThan(0);
    expect(res.features.RNA.common).toBeGreaterThan(0);
    expect(res.features.ADT.common).toBeGreaterThan(0);

    // still works with multiple hits.
    let res2 = await bakana.validateAnnotations(
        {
            mtx: {
                format: "MatrixMarket",
                mtx: "files/datasets/immune_3.0.0-matrix.mtx.gz",
                genes: "files/datasets/immune_3.0.0-features.tsv.gz",
                annotations: "files/datasets/immune_3.0.0-barcodes.tsv.gz"
            },
            tenx: {
                format: "10X",
                h5: "files/datasets/immune_3.0.0-tenx.h5"
            }
        }
    );

    expect(Object.keys(res.annotations.default).length).toBeGreaterThan(0);
    expect(res.features.RNA.common).toBeGreaterThan(0);
    expect(res.features.ADT.common).toBeGreaterThan(0);
})


