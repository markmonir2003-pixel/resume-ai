import { Link, useNavigate, useParams } from "react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { usePuterStore } from "~/lib/puter";
import Summary from "~/components/Summary";
import ATS from "~/components/ATS";
import Details from "~/components/Details";

export const meta = () => [
    { title: "Resumind | Review" },
    { name: "description", content: "Detailed overview of your resume" },
];

/** Initial polling interval */
const INITIAL_POLL_MS = 1200;
/** Max polling interval after backoff */
const MAX_POLL_MS = 12000;
/** Max total polling time — increased to 5 minutes for slower models like Claude */
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const Resume = () => {
    const { auth, isLoading, fs, kv } = usePuterStore();
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();

    const [imageUrl, setImageUrl] = useState<string>("");
    const [resumeUrl, setResumeUrl] = useState<string>("");
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [analysisError, setAnalysisError] = useState<string | null>(null);
    const [isPolling, setIsPolling] = useState(false);

    const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const objectUrlsRef = useRef<string[]>([]);
    const startTimeRef = useRef<number>(0); // ← FIX: use ref to avoid TDZ/NaN issues

    const revokePreviousUrls = useCallback(() => {
        objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
        objectUrlsRef.current = [];
    }, []);

    const stopPolling = useCallback(() => {
        if (pollRef.current) {
            clearTimeout(pollRef.current);
            pollRef.current = null;
        }
        setIsPolling(false);
    }, []);

    // Redirect if not authenticated
    useEffect(() => {
        if (!isLoading && !auth.isAuthenticated) {
            navigate(`/auth?next=/resume/${id}`);
        }
    }, [isLoading, auth.isAuthenticated, id, navigate]);

    useEffect(() => {
        if (!id) return;

        let mounted = true;

        const loadAndPoll = async () => {
            try {
                const raw = await kv.get(`resume:${id}`);
                if (!raw || !mounted) return;

                const data = JSON.parse(raw);

                // Load blobs in parallel
                const [resumeBlob, imageBlob] = await Promise.all([
                    fs.read(data.resumePath).catch(() => null),
                    fs.read(data.imagePath).catch(() => null),
                ]);

                if (!mounted) return;

                revokePreviousUrls();

                if (resumeBlob) {
                    const pdf = new Blob([resumeBlob], { type: "application/pdf" });
                    const url = URL.createObjectURL(pdf);
                    setResumeUrl(url);
                    objectUrlsRef.current.push(url);
                }

                if (imageBlob) {
                    const url = URL.createObjectURL(imageBlob);
                    setImageUrl(url);
                    objectUrlsRef.current.push(url);
                }

                // Early exit if already finished
                if (data.status === "complete" && data.feedback) {
                    setFeedback(data.feedback);
                    setIsPolling(false);
                    return;
                }
                if (data.status === "failed" || data.error) {
                    setAnalysisError(data.error || "Analysis failed. Please try again.");
                    setIsPolling(false);
                    return;
                }

                // Still pending → start polling
                setIsPolling(true);
                startTimeRef.current = Date.now(); // ← Set here safely
                let currentDelay = INITIAL_POLL_MS;

                const poll = async () => {
                    if (!mounted) return;

                    try {
                        const raw = await kv.get(`resume:${id}`);
                        if (!raw || !mounted) return;

                        const updated = JSON.parse(raw);
                        console.log("[Polling] Current status:", updated.status); // ← Debug log

                        if (updated.status === "complete" && updated.feedback) {
                            setFeedback(updated.feedback as Feedback);
                            stopPolling();
                            return;
                        }
                        if (updated.status === "failed" || updated.error) {
                            setAnalysisError(updated.error || "Analysis failed");
                            stopPolling();
                            return;
                        }

                        const elapsed = Date.now() - startTimeRef.current;
                        if (elapsed > POLL_TIMEOUT_MS) {
                            setAnalysisError("Analysis is taking too long. Please try again later.");
                            stopPolling();
                            return;
                        }

                        // Exponential backoff with jitter
                        currentDelay = Math.min(
                            MAX_POLL_MS,
                            currentDelay * 1.6 + Math.random() * 400
                        );

                        pollRef.current = setTimeout(poll, currentDelay);
                    } catch (err) {
                        console.error("[Resume:poll]", err);
                        currentDelay = Math.min(MAX_POLL_MS, currentDelay * 2);
                        pollRef.current = setTimeout(poll, currentDelay);
                    }
                };

                pollRef.current = setTimeout(poll, currentDelay);
            } catch (err) {
                console.error("[Resume:load]", err);
                if (mounted) {
                    setAnalysisError("فشل تحميل بيانات السيرة الذاتية");
                }
            }
        };

        loadAndPoll();

        return () => {
            mounted = false;
            stopPolling();
            revokePreviousUrls();
        };
    }, [id, kv, fs, revokePreviousUrls, stopPolling]);

    const showLoading = isPolling && !feedback && !analysisError;

    return (
        <main className="!pt-0">
            <nav className="resume-nav">
                <Link to="/" className="back-button flex items-center gap-2">
                    <img src="/icons/back.svg" alt="back" className="w-2.5 h-2.5" />
                    <span className="text-gray-800 text-sm font-semibold">
                        Back to Homepage
                    </span>
                </Link>
            </nav>

            <div className="flex flex-row w-full max-lg:flex-col">
                {/* Left: Resume preview */}
                <section className="feedback-section bg-[url('/images/bg-small.svg')] bg-cover lg:h-[100vh] lg:sticky lg:top-0 flex items-center justify-center max-lg:min-h-[260px] max-lg:py-6">
                    {imageUrl && resumeUrl ? (
                        <div className="animate-in fade-in duration-700 gradient-border max-sm:m-0 max-lg:h-[240px] lg:h-[90%] w-fit">
                            <a href={resumeUrl} target="_blank" rel="noopener noreferrer">
                                <img
                                    src={imageUrl}
                                    alt="Resume preview"
                                    className="w-full h-full object-contain rounded-2xl shadow-2xl"
                                    title="Click to open PDF"
                                />
                            </a>
                        </div>
                    ) : (
                        <div className="text-gray-500 animate-pulse">Loading preview...</div>
                    )}
                </section>

                {/* Right: Feedback */}
                <section className="feedback-section p-4 md:p-10">
                    <h2 className="text-2xl md:text-4xl !text-black font-bold mb-6 md:mb-8">Resume Review</h2>

                    {analysisError ? (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-5 text-red-700">
                            ⚠️ {analysisError}
                        </div>
                    ) : feedback ? (
                        <div className="flex flex-col gap-10 animate-in fade-in duration-800 slide-in-from-bottom-4">
                            <Summary feedback={feedback} />
                            <ATS score={feedback.ATS?.score ?? 0} suggestions={feedback.ATS?.tips ?? []} />
                            <Details feedback={feedback} />
                        </div>
                    ) : showLoading ? (
                        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
                            <img
                                src="/images/resume-scan-2.gif"
                                alt="Analyzing resume"
                                className="w-64 md:w-80"
                            />
                            <p className="text-lg text-gray-600 font-medium">
                                Analyzing your resume... (usually 15–60 seconds)
                            </p>
                            <p className="text-sm text-gray-500">
                                You can safely leave this page — results will be ready when you return.
                            </p>
                        </div>
                    ) : null}
                </section>
            </div>
        </main>
    );
};

export default Resume;