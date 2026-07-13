import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stableCaseId } from "../domain/evidence.js";

export interface CaseWorkspace {
  caseId: string;
  root: string;
  paths: {
    caseDir: string;
    sourceDir: string;
    pagesDir: string;
    indexDir: string;
    artifactsDir: string;
    exportsDir: string;
    sourcePdf: string;
    manifest: string;
    status: string;
    db: string;
    pageLedgerSnapshot: string;
    coverageManifest: string;
  };
}

function nearestExistingPath(inputPath: string): string {
  let current = inputPath;

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Path does not have an existing ancestor: ${inputPath}`);
    }
    current = parent;
  }

  return current;
}

function canonicalizeCandidate(candidateAbs: string): string {
  const existingAncestor = nearestExistingPath(candidateAbs);
  const canonicalAncestor = realpathSync(existingAncestor);

  if (existingAncestor === candidateAbs) {
    return canonicalAncestor;
  }

  return resolve(canonicalAncestor, relative(existingAncestor, candidateAbs));
}

function isInsideCanonicalRoot(rootCanonical: string, candidateCanonical: string): boolean {
  const pathToCandidate = relative(rootCanonical, candidateCanonical);
  return pathToCandidate === "" || (!pathToCandidate.startsWith("..") && !isAbsolute(pathToCandidate));
}

export function resolveInsideRoot(root: string, candidate: string): string {
  const rootAbs = resolve(root);
  const targetAbs = resolve(candidate);

  const rootCanonical = existsSync(rootAbs) ? realpathSync(rootAbs) : rootAbs;
  const targetCanonical = canonicalizeCandidate(targetAbs);

  if (!isInsideCanonicalRoot(rootCanonical, targetCanonical)) {
    throw new Error(`Path is outside the authorized cases directory: ${candidate}`);
  }
  return targetAbs;
}

export function createWorkspace(root: string, pdfPath: string, slug?: string): CaseWorkspace {
  mkdirSync(root, { recursive: true });
  const guardedPdf = resolveInsideRoot(root, pdfPath);
  const caseId = slug?.trim() ? stableCaseId(slug.trim()) : stableCaseId(guardedPdf);
  const caseDir = join(root, caseId);
  const sourceDir = join(caseDir, "source");
  const pagesDir = join(caseDir, "pages");
  const indexDir = join(caseDir, "index");
  const artifactsDir = join(caseDir, "artifacts");
  const exportsDir = join(caseDir, "exports");

  for (const dir of [caseDir, sourceDir, pagesDir, indexDir, artifactsDir, exportsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const sourcePdf = join(sourceDir, basename(guardedPdf));
  copyFileSync(guardedPdf, sourcePdf);

  return {
    caseId,
    root: realpathSync(root),
    paths: {
      caseDir,
      sourceDir,
      pagesDir,
      indexDir,
      artifactsDir,
      exportsDir,
      sourcePdf,
      manifest: join(caseDir, "case.json"),
      status: join(caseDir, "status.json"),
      db: join(indexDir, "case.sqlite"),
      pageLedgerSnapshot: join(artifactsDir, "page_ledger.snapshot.json"),
      coverageManifest: join(artifactsDir, "coverage_manifest.json")
    }
  };
}
