/**
 * 协调会话列表刷新：普通刷新复用在途请求，强制刷新开启新代次，
 * 旧请求即使晚返回也不能覆盖更新后的列表。
 */
export function createSessionRefreshCoordinator<T>(
  fetchSessions: () => Promise<T[]>,
  getCurrent: () => T[],
  setCurrent: (sessions: T[]) => void,
) {
  let generation = 0;
  let inFlight: { generation: number; promise: Promise<T[]> } | null = null;

  function load(force = false): Promise<T[]> {
    if (!force && inFlight) return inFlight.promise;

    const requestGeneration = ++generation;
    let promise: Promise<T[]>;
    promise = fetchSessions()
      .then((sessions) => {
        if (requestGeneration === generation) {
          setCurrent(sessions);
          return sessions;
        }
        const newer = inFlight?.promise;
        if (newer && newer !== promise) {
          return newer.then(
            () => getCurrent(),
            () => getCurrent(),
          );
        }
        return getCurrent();
      })
      .catch((error) => {
        // 强制刷新已经开启新代次时，旧调用者不应暴露旧请求的失败；
        // 与成功路径保持一致，等待最新请求并返回当前列表。
        if (requestGeneration !== generation) {
          const newer = inFlight?.promise;
          if (newer && newer !== promise) {
            return newer.then(
              () => getCurrent(),
              () => getCurrent(),
            );
          }
          return getCurrent();
        }
        throw error;
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { generation: requestGeneration, promise };
    return promise;
  }

  return { load };
}
