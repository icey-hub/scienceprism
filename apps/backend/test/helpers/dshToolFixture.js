// Contract fixture for the SDK's middleware/final-guard boundary. Real SDK
// behavior is verified separately by the repository-local no-model probe.
export function createDshToolFixture() {
  const listeners = new Map();
  const guards = [];
  const definitions = new Map();
  const ctx = {
    llm: { listProviders: () => [{ id: 'scienceprism-configured' }] },
    on(name, callback, options) {
      const values = listeners.get(name) || []; listeners.set(name, values);
      if (options?.prepend) values.unshift(callback); else values.push(callback);
      return () => { const index = values.indexOf(callback); if (index !== -1) values.splice(index, 1); };
    },
    tools: {
      register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); },
      guard(callback) { guards.push(callback); },
      async execute(execution) {
        const failed = reason => ({ isError: true, content: [{ type: 'text', text: String(reason) }] });
        const definition = definitions.get(execution.name);
        if (!definition) return failed('Unknown tool');
        if (execution.signal.aborted) return failed('Cancelled');
        const callbacks = [...(listeners.get('tools/pre-execute') || [])];
        const next = async index => index < callbacks.length ? callbacks[index](execution, () => next(index + 1)) : { kind: 'allow' };
        try {
          const admission = await next(0);
          if (admission.kind !== 'allow') return failed(admission.reason || admission.kind);
          for (const guard of guards) { const reason = guard(execution); if (reason !== undefined) return failed(reason); }
          const value = await definition.execute(execution.arguments, execution);
          return { isError: false, value, content: definition.output.render(execution.arguments, value) };
        } catch (error) { return failed(error.message); }
      }
    },
    async dispose() { for (const callback of listeners.get('dispose') || []) await callback(); }
  };
  return ctx;
}
