export interface PdfConversionResult {
    imageUrl: string;
    file: File | null;
    error?: string;
}

let pdfjsLib: any = null;
let loadPromise: Promise<any> | null = null;

// Shared loader — ensures pdfjs-dist is loaded only once regardless of which
// function calls it first (convertPdfToImage OR extractTextFromPdf).
async function loadPdfJs(): Promise<any> {
    if (pdfjsLib) return pdfjsLib;
    if (loadPromise) return loadPromise;

    // @ts-expect-error - pdfjs-dist/build/pdf.mjs has no bundled type declaration
    loadPromise = import("pdfjs-dist/build/pdf.mjs").then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        pdfjsLib = lib;
        return lib;
    });

    return loadPromise;
}

// ─── Image conversion ──────────────────────────────────────────────────────
// Converts the first page of a PDF to a PNG image for the resume preview.
// Scale 2 (not 4) = 4× fewer pixels → much faster render + toBlob.
// Quality 0.92 = faster encoding with no meaningful quality loss for AI OCR.
export async function convertPdfToImage(file: File): Promise<PdfConversionResult> {
    try {
        const lib = await loadPdfJs();

        const arrayBuffer = await file.arrayBuffer();
        const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
        const page = await pdf.getPage(1);

        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        if (context) {
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = "high";
        }

        await page.render({ canvasContext: context!, viewport }).promise;

        return new Promise((resolve) => {
            canvas.toBlob(
                (blob) => {
                    if (blob) {
                        const originalName = file.name.replace(/\.pdf$/i, "");
                        const imageFile = new File([blob], `${originalName}.png`, {
                            type: "image/png",
                        });
                        resolve({
                            imageUrl: URL.createObjectURL(blob),
                            file: imageFile,
                        });
                    } else {
                        resolve({
                            imageUrl: "",
                            file: null,
                            error: "Failed to create image blob",
                        });
                    }
                },
                "image/png",
                0.92
            );
        });
    } catch (err) {
        return {
            imageUrl: "",
            file: null,
            error: `Failed to convert PDF: ${err}`,
        };
    }
}

// ─── Text extraction ───────────────────────────────────────────────────────
// Extracts raw text from a PDF using pdfjs-dist.
// Used for sending resume content to AI models as a text prompt,
// which works with ALL models (no puter_path needed → free models work).
export async function extractTextFromPdf(
    file: File | Blob,
    maxPages = 5        // cap pages to keep prompt size reasonable
): Promise<string> {
    try {
        const lib = await loadPdfJs();
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await lib.getDocument({ data: arrayBuffer }).promise;

        const pagesToRead = Math.min(pdf.numPages, maxPages);
        const pageTexts: string[] = [];

        for (let i = 1; i <= pagesToRead; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            // content.items is an array of TextItem objects with a .str property
            const pageText = content.items
                .map((item: any) => item.str)
                .join(" ");
            pageTexts.push(pageText);
        }

        return pageTexts.join("\n\n").trim();
    } catch (err) {
        console.error("[extractTextFromPdf] Failed:", err);
        return "";   // return empty string rather than crashing — caller handles it
    }
}
