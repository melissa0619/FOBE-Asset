/** Submit each intended mapping once, stopping at the first failed request. */
export function createSubmissionGuard() {
  let isSubmitting = false;
  return async work => {
    if (isSubmitting) return { skipped: true };
    isSubmitting = true;
    try {
      return { skipped: false, value: await work() };
    } finally {
      isSubmitting = false;
    }
  };
}

export async function submitMappingEntries(entries, submit) {
  let submitted = 0;
  for (const entry of entries) {
    try {
      await submit(entry);
      submitted += 1;
    } catch (error) {
      return { submitted, error };
    }
  }
  return { submitted, error: null };
}
