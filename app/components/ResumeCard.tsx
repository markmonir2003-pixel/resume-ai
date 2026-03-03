import { Link } from "react-router";
import ScoreCircle from "~/components/ScoreCircle";
import { useEffect, useState } from "react";
import { usePuterStore } from "~/lib/puter";

const ResumeCard = ({ resume: { id, companyName, jobTitle, feedback, imagePath, status } }: { resume: Resume }) => {
    const { fs } = usePuterStore();
    const [resumeUrl, setResumeUrl] = useState('');

    useEffect(() => {
        let objectUrl = '';

        const loadResume = async () => {
            const blob = await fs.read(imagePath);
            if (!blob) return;
            // FIX: store the URL so we can revoke it on cleanup
            objectUrl = URL.createObjectURL(blob);
            setResumeUrl(objectUrl);
        };

        loadResume();

        // FIX: revoke the object URL on unmount / imagePath change to prevent memory leaks
        return () => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
        // FIX: added `fs` to deps — was missing, causing stale-closure lint warning
    }, [imagePath, fs]);

    // Resume is still being analysed in the background — render a skeleton card
    // instead of crashing on feedback.overallScore (which would be null).
    const isPending = !feedback || status === 'pending';

    return (
        <Link to={`/resume/${id}`} className="resume-card animate-in fade-in duration-1000">
            <div className="resume-card-header">
                <div className="flex flex-col gap-2">
                    {companyName && <h2 className="!text-black font-bold break-words">{companyName}</h2>}
                    {jobTitle && <h3 className="text-lg break-words text-gray-500">{jobTitle}</h3>}
                    {!companyName && !jobTitle && <h2 className="!text-black font-bold">Resume</h2>}
                </div>
                <div className="flex-shrink-0">
                    {isPending ? (
                        // Animated pulse badge while AI analysis is still running
                        <div className="flex flex-col items-center justify-center w-16 h-16 rounded-full bg-gray-100 border-2 border-dashed border-gray-300 animate-pulse">
                            <span className="text-xs text-gray-400 text-center leading-tight">
                                Analyzing…
                            </span>
                        </div>
                    ) : (
                        <ScoreCircle score={feedback!.overallScore} />
                    )}
                </div>
            </div>
            {resumeUrl && (
                <div className="gradient-border animate-in fade-in duration-1000">
                    <div className="w-full h-full">
                        <img
                            src={resumeUrl}
                            alt="resume"
                            className="w-full h-[350px] max-sm:h-[200px] object-cover object-top"
                        />
                    </div>
                </div>
            )}
        </Link>
    );
};

export default ResumeCard;
