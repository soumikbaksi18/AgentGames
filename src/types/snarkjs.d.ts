declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmFile: string | { type: "mem"; data: Uint8Array },
      zkeyFile: string | { type: "mem"; data: Uint8Array },
      logger?: unknown,
    ): Promise<{ proof: any; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: unknown, logger?: unknown): Promise<boolean>;
  };
}

declare module "circom_runtime" {
  export function WitnessCalculatorBuilder(code: Uint8Array): Promise<{
    calculateWitness(input: Record<string, unknown>, sanityCheck: boolean): Promise<bigint[]>;
  }>;
}
