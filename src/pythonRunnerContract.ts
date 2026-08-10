export const PYTHON_RUNNER_PROTOCOL_VERSION = 3 as const;
export const PYTHON_RUNNER_PUBLIC_FILE = "python-runner.worker.js" as const;
export const PYTHON_RUNNER_WORKER_URL =
  `/${PYTHON_RUNNER_PUBLIC_FILE}?protocol=${PYTHON_RUNNER_PROTOCOL_VERSION}` as const;
