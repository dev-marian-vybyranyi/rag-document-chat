import type { CodeLocation } from '../documents/api';
import { isCommitSha, safeGithubUrl } from '../documents/repository-status';

export function githubPermalink(
  repository: { repoUrl: string | null; commitSha: string | null },
  code: CodeLocation,
): string | null {
  const base = safeGithubUrl(repository.repoUrl);
  if (!base || !isCommitSha(repository.commitSha)) return null;

  const path = code.path.split('/').map(encodeURIComponent).join('/');
  let anchor = '';
  if (code.startLine !== null) {
    anchor =
      code.endLine === null || code.endLine === code.startLine
        ? `#L${code.startLine}`
        : `#L${code.startLine}-L${code.endLine}`;
  }
  return `${base}/blob/${repository.commitSha}/${path}${anchor}`;
}
