import { type FormEvent, useState, useEffect, useRef } from "react";
import Navbar from "~/components/Navbar";
import FileUploader from "~/components/FileUploader";
import { usePuterStore } from "~/lib/puter";
import { useNavigate } from "react-router";
import { convertPdfToImage, extractTextFromPdf } from "~/lib/pdf2img";
import { generateUUID } from "~/lib/utils";
import { prepareInstructions } from "../../constants";

// ─── ClientOnly ──────────────────────────────────────────────────────────────
// Prevents hydration mismatch when logic runs in SSR mode.
const ClientOnly = ({ children }: { children: React.ReactNode }) => {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    if (!mounted) return null;
    return <>{children}</>;
};

// ─── Types ───────────────────────────────────────────────────────────────────
type AnalysisStatus = "pending" | "complete" | "failed";

export interface AnalysisData {
    id: string;
    resumePath: string;
    imagePath: string;
    companyName: string;
    jobTitle: string;
    jobDescription: string;
    feedback: unknown | null;
    error?: string;
    status: AnalysisStatus;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise any thrown value to a readable string. */
function toMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "object" && err !== null) {
        const e = err as Record<string, unknown>;
        return (
            (typeof e.message === "string" ? e.message : null) ??
            (typeof e.error === "string" ? e.error : null) ??
            JSON.stringify(err)
        );
    }
    return String(err);
}

/** Schedule a callback after the browser is idle (or after ~100 ms). */
function defer(fn: () => Promise<void>): void {
    if ("requestIdleCallback" in window) {
        window.requestIdleCallback(() => { fn(); }, { timeout: 5_000 });
    } else {
        setTimeout(() => { fn(); }, 100);
    }
}

/** Strip markdown code fences that some models wrap around JSON. */
function stripCodeFences(text: string): string {
    return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

// ─── Component ───────────────────────────────────────────────────────────────
const Upload = () => {
    const { fs, ai, kv, setLoadingState } = usePuterStore();
    const navigate = useNavigate();

    const [file, setFile] = useState<File | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [statusText, setStatusText] = useState("");
    const [imageError, setImageError] = useState<string | null>(null);

    // Store the pre-warmed image upload promise in a ref (NOT state) —
    // storing a Promise in useState causes React to call .then() on it.
    const imageUploadRef = useRef<Promise<FSItem | undefined> | null>(null);

    // Kick off PDF→image conversion + upload as soon as a file is selected,
    // so it is ready (or nearly ready) when the user clicks "Analyze Resume".
    useEffect(() => {
        if (!file) {
            imageUploadRef.current = null;
            setImageError(null);
            return;
        }

        setImageError(null);
        imageUploadRef.current = convertPdfToImage(file)
            .then((result) => {
                if (!result.file) throw new Error("PDF → image conversion failed");
                // fs.upload returns FSItem | undefined, NOT an array
                return fs.upload([result.file]);
            })
            .catch((err: unknown) => {
                setImageError(toMessage(err));
                return undefined;
            });
    }, [file, fs]);

    // ─── Submit handler ─────────────────────────────────────────────────────────
    const handleAnalyze = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!file) return;

        const formData = new FormData(e.currentTarget);
        const companyName = (formData.get("company-name") as string) ?? "";
        const jobTitle = (formData.get("job-title") as string) ?? "";
        const jobDescription = (formData.get("job-description") as string) ?? "";

        setIsProcessing(true);
        setStatusText("Uploading resume…");
        setLoadingState("upload", true);

        let uploadedPdf: FSItem | undefined;
        let uploadedImage: FSItem | undefined;

        // ── Parallel upload ─────────────────────────────────────────────────────
        try {
            // Run PDF upload and pre-warmed image upload concurrently.
            // fs.upload() returns FSItem | undefined (NOT an array — don't destructure with []).
            [uploadedPdf, uploadedImage] = await Promise.all([
                fs.upload([file]),
                imageUploadRef.current ?? Promise.resolve(undefined),
            ]);

            // Fallback: if pre-warming failed or wasn't started yet, try image inline.
            if (!uploadedImage) {
                setStatusText("Converting PDF to image…");
                const imgResult = await convertPdfToImage(file);
                if (imgResult.file) {
                    uploadedImage = await fs.upload([imgResult.file]);
                }
            }

            if (!uploadedPdf) throw new Error("PDF upload failed — please try again.");
        } catch (err) {
            setStatusText(`Error: ${toMessage(err)}`);
            setIsProcessing(false);
            return;
        } finally {
            setLoadingState("upload", false);
        }

        // ── Optimistic KV save + instant navigation ─────────────────────────────
        // Write a "pending" record so the resume page can render the preview
        // immediately while AI analysis runs in the background.
        const uuid = generateUUID();
        const skeleton: AnalysisData = {
            id: uuid,
            resumePath: uploadedPdf.path,
            imagePath: uploadedImage?.path ?? "",
            companyName,
            jobTitle,
            jobDescription,
            feedback: null,
            status: "pending",
        };

        setStatusText("Starting analysis…");
        await kv.set(`resume:${uuid}`, JSON.stringify(skeleton));

        // Navigate immediately — the resume page polls KV until feedback appears.
        navigate(`/resume/${uuid}`);

        // ── Background AI analysis ───────────────────────────────────────────────
        // This closure runs AFTER navigation via defer(). The Zustand store
        // methods (kv, ai, setLoadingState) remain accessible after unmount.
        const pdfPath = uploadedPdf.path; // capture before any state resets

        const doAnalysis = async (): Promise<void> => {
            try {
                setLoadingState("analysis", true);
                console.log("[doAnalysis] Starting background AI analysis…");

                // ── Step 1: Extract text from the uploaded PDF ──────────────────────
                // We read the PDF blob from Puter FS, then use pdfjs to pull the text.
                // This lets us use ANY model (not just Anthropic) because we send
                // the resume content as plain text in the prompt — no puter_path needed.
                let resumeText = "";
                try {
                    const pdfBlob = await fs.read(pdfPath);
                    if (pdfBlob) {
                        resumeText = await extractTextFromPdf(pdfBlob as Blob);
                        console.log(`[doAnalysis] Extracted ${resumeText.length} characters from PDF`);
                    }
                } catch (readErr) {
                    // Non-fatal — continue with empty resumeText (model will still
                    // provide generic advice based on the job description alone).
                    console.warn("[doAnalysis] Could not extract PDF text:", readErr);
                }

                // ── Step 2: Build the prompt ────────────────────────────────────────
                const prompt = prepareInstructions({ jobTitle, jobDescription, resumeText });

                // ── Step 3: Call a free AI model via Puter ──────────────────────────
                // Using gpt-4o-mini: reliable, fast, and excellent at structured JSON.
                // It receives the prompt as plain text — no file attachment needed.
                // Model IDs on Puter use the format "provider/model-name".
                console.log("[doAnalysis] Calling AI model: openai/gpt-4o-mini");
                const aiResponse = await ai.chat(
                    [{ role: "user", content: prompt }],
                    { model: "openai/gpt-4o-mini" }
                );

                if (!aiResponse) throw new Error("No response from AI");

                // ── Step 4: Extract response text (handles all response shapes) ─────
                const rawContent = aiResponse?.message?.content;
                let text: string | undefined;

                if (typeof rawContent === "string") {
                    text = rawContent;
                } else if (Array.isArray(rawContent) && rawContent.length > 0) {
                    const first = rawContent[0];
                    text = typeof first === "string"
                        ? first
                        : (first?.text ?? first?.value ?? "");
                }

                if (!text) throw new Error("Empty AI response — no text content returned");

                // ── Step 5: Strip markdown fences + parse JSON ──────────────────────
                const cleaned = stripCodeFences(text);
                let parsed: unknown;
                try {
                    parsed = JSON.parse(cleaned);
                } catch {
                    throw new Error(`AI returned non-JSON: ${cleaned.slice(0, 150)}`);
                }

                // ── Step 6: Write complete record to KV ────────────────────────────
                console.log("[doAnalysis] Analysis complete — writing to KV");
                await kv.set(
                    `resume:${uuid}`,
                    JSON.stringify({
                        ...skeleton,
                        feedback: parsed,
                        status: "complete",
                    } satisfies AnalysisData)
                );
            } catch (err) {
                const errorMsg = toMessage(err);
                console.error("[doAnalysis] Failed:", errorMsg, err);
                await kv.set(
                    `resume:${uuid}`,
                    JSON.stringify({
                        ...skeleton,
                        status: "failed",
                        error: errorMsg,
                    } satisfies AnalysisData)
                );
            } finally {
                setLoadingState("analysis", false);
            }
        };

        // Schedule background analysis without blocking navigation.
        defer(doAnalysis);

        setIsProcessing(false);
        setStatusText("");
    };

    // ─── Render ──────────────────────────────────────────────────────────────────
    return (
        <main className="bg-[url('/images/bg-main.svg')] bg-cover min-h-screen">
            <Navbar />

            <section className="main-section px-4 py-12 max-w-4xl mx-auto">
                <div className="page-heading text-center">
                    <h1 className="text-4xl font-bold mb-6">Smart feedback for your dream job</h1>

                    <ClientOnly>
                        {isProcessing ? (
                            <div className="mt-8">
                                <h2 className="text-2xl mb-6">{statusText}</h2>
                                <img
                                    src="/images/resume-scan.gif"
                                    alt="Scanning resume"
                                    className="w-full max-w-md mx-auto"
                                />
                            </div>
                        ) : (
                            <>
                                <h2 className="text-xl mb-10 text-gray-700">
                                    Drop your resume for an ATS score and improvement tips
                                </h2>

                                <form
                                    onSubmit={handleAnalyze}
                                    className="flex flex-col gap-6 mt-8 bg-white/80 backdrop-blur-sm p-8 rounded-xl shadow-lg text-left"
                                >
                                    <div className="form-div">
                                        <label htmlFor="company-name">Company Name</label>
                                        <input
                                            type="text"
                                            name="company-name"
                                            id="company-name"
                                            placeholder="e.g. Google, Meta, xAI"
                                            required
                                        />
                                    </div>

                                    <div className="form-div">
                                        <label htmlFor="job-title">Job Title</label>
                                        <input
                                            type="text"
                                            name="job-title"
                                            id="job-title"
                                            placeholder="e.g. Senior Frontend Engineer"
                                            required
                                        />
                                    </div>

                                    <div className="form-div">
                                        <label htmlFor="job-description">Job Description</label>
                                        <textarea
                                            rows={5}
                                            name="job-description"
                                            id="job-description"
                                            placeholder="Paste the full job description here…"
                                            required
                                        />
                                    </div>

                                    <div className="form-div">
                                        <label htmlFor="uploader">Upload Resume (PDF)</label>
                                        <FileUploader onFileSelect={setFile} />
                                        {imageError && (
                                            <p className="text-amber-600 text-sm mt-1">
                                                ⚠️ Preview image: {imageError}
                                            </p>
                                        )}
                                    </div>

                                    <button
                                        type="submit"
                                        disabled={!file || isProcessing}
                                        className="primary-button disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {isProcessing ? "Processing…" : "Analyze Resume"}
                                    </button>
                                </form>
                            </>
                        )}
                    </ClientOnly>
                </div>
            </section>
        </main>
    );
};

export default Upload;