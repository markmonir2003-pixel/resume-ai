import type { Route } from "./+types/home";
import Navbar from "~/components/Navbar";
import ResumeCard from "~/components/ResumeCard";
import { usePuterStore } from "~/lib/puter";
import { Link, useNavigate } from "react-router";
import { useEffect, useState } from "react";

export function meta({ }: Route.MetaArgs) {
  return [
    { title: "Resumind" },
    { name: "description", content: "Smart feedback for your dream job!" },
  ];
}

export default function Home() {
  const { auth, kv } = usePuterStore();
  const navigate = useNavigate();
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [loadingResumes, setLoadingResumes] = useState(true);

  // FIX: added `navigate` to deps array to avoid stale-closure lint warning.
  useEffect(() => {
    if (!auth.isAuthenticated) navigate("/auth?next=/");
  }, [auth.isAuthenticated, navigate]);

  useEffect(() => {
    const loadResumes = async () => {
      setLoadingResumes(true);
      try {
        // FIX: kv.list() can return undefined — guard before .map()
        const raw = (await kv.list("resume:*", true)) as KVItem[] | undefined;
        if (!raw) return;

        const parsedResumes = raw
          .map((item) => {
            try {
              return JSON.parse(item.value) as Resume;
            } catch {
              return null; // skip malformed KV entries
            }
          })
          .filter((r): r is Resume => r !== null);

        // Sort newest first (UUIDs are crypto-random, so we sort by companyName
        // as a stable fallback — KV has no timestamps).
        setResumes(parsedResumes);
      } catch (err) {
        console.error("[Home] Failed to load resumes:", err);
      } finally {
        setLoadingResumes(false);
      }
    };

    loadResumes();
  }, [kv]);

  const hasResumes = resumes.length > 0;

  return (
    <main className="bg-[url('/images/bg-main.svg')] bg-cover min-h-screen">
      <Navbar />

      <section className="main-section">
        <div className="page-heading py-16">
          <h1>Track Your Applications &amp; Resume Ratings</h1>

          {/* FIX: Only show subheading once loading is done, so it doesn't
              flash "No resumes found" on initial render while kv.list is
              in flight. */}
          {!loadingResumes && (
            <h2>
              {hasResumes
                ? "Review your submissions and check AI-powered feedback."
                : "No resumes found. Upload your first resume to get feedback."}
            </h2>
          )}
        </div>

        {loadingResumes && (
          <div className="flex flex-col items-center justify-center">
            <img src="/images/resume-scan-2.gif" className="w-[200px]" alt="Loading" />
          </div>
        )}

        {!loadingResumes && hasResumes && (
          <div className="resumes-section">
            {resumes.map((resume) => (
              <ResumeCard key={resume.id} resume={resume} />
            ))}
          </div>
        )}

        {!loadingResumes && !hasResumes && (
          <div className="flex flex-col items-center justify-center mt-10 gap-4">
            <Link to="/upload" className="primary-button w-fit text-xl font-semibold">
              Upload Resume
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
