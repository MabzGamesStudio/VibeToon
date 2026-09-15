import { useEffect, useState } from 'react';
import { inputsForPort, type FlowNode, type Lexicon, type Project, type TextRunSource } from '@vibetoon/shared';
import { api } from '../../api/client';

interface Loaded {
  sources: TextRunSource[];
  loading: boolean;
  error: string | null;
}

/**
 * Reads what is wired into a text flow so the editor can preview exactly what a
 * run would produce: the text on the Text input and any word database on the
 * Lexicon input, both fetched from the artifacts they were generated into.
 */
export function useUpstreamText(project: Project, node: FlowNode): Loaded {
  const [state, setState] = useState<Loaded>({ sources: [], loading: false, error: null });

  const incoming = [
    ...inputsForPort(project, node.id, 'text'),
    ...inputsForPort(project, node.id, 'lexicon'),
  ];
  // Refetch only when a wire, its rules, or the artifact behind it changes.
  const signature = incoming
    .map((input) => `${input.connection.id}:${input.connection.rules}:${input.artifact?.hash ?? '-'}`)
    .join('|');

  useEffect(() => {
    let cancelled = false;
    if (incoming.length === 0) {
      setState({ sources: [], loading: false, error: null });
      return;
    }

    setState((current) => ({ ...current, loading: true }));
    void (async () => {
      const sources: TextRunSource[] = [];
      let error: string | null = null;

      for (const input of incoming) {
        const port = input.connection.to.portId;
        const label = `${input.sourceNode.name} → ${input.targetPort?.label ?? port}`;
        const base = { port, label, rules: input.connection.rules };
        if (!input.artifact) {
          sources.push(base);
          continue;
        }
        try {
          const body = await api.artifactText(project.id, input.artifact.path);
          if (port === 'lexicon') {
            const parsed = JSON.parse(body) as Lexicon;
            sources.push({ ...base, lexicon: parsed });
          } else {
            sources.push({ ...base, text: body });
          }
        } catch (cause) {
          error = `Could not read ${input.artifact.fileName}: ${(cause as Error).message}`;
          sources.push(base);
        }
      }

      if (!cancelled) setState({ sources, loading: false, error });
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, signature]);

  return state;
}
