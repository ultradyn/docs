import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data?: T;
  error?: Error;
  loading: boolean;
}

export function useAsyncResource<T>(
  load: () => Promise<T>,
  dependencies: readonly unknown[],
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ loading: true });
  const [revision, setRevision] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let current = true;
    setState((previous) =>
      previous.data === undefined
        ? { loading: true }
        : { data: previous.data, loading: true },
    );
    void loadRef.current().then(
      (data) => {
        if (current) setState({ data, loading: false });
      },
      (error: unknown) => {
        if (current)
          setState({
            loading: false,
            error:
              error instanceof Error
                ? error
                : new Error("Something went wrong"),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [...dependencies, revision]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { ...state, reload };
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Ultradyn Docs`;
  }, [title]);
}
