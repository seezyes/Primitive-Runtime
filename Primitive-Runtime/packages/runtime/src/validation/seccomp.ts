import { RuntimeError } from "../errors.js";

/**
 * Linux x86-64 classic BPF. Block namespace/mount escape routes, privileged kernel
 * interfaces, tracing other processes, and x32/compat syscalls. clone3 returns
 * ENOSYS so libc may use the filtered clone syscall for ordinary child processes.
 * This complements namespaces and capability dropping, rather than replacing them.
 */
export function seccompFilter(): Buffer {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new RuntimeError(
      "UNSUPPORTED_SANDBOX",
      "The bubblewrap seccomp policy is supported on Linux x64 only.",
    );
  }
  const instructions: Array<[number, number, number, number]> = [];
  const emit = (code: number, jt: number, jf: number, k: number) =>
    instructions.push([code, jt, jf, k]);
  const load = (offset: number) => emit(0x20, 0, 0, offset);
  const ret = (value: number) => emit(0x06, 0, 0, value);
  const deny = (syscall: number, errno = 1) => {
    emit(0x15, 0, 1, syscall);
    ret(0x00050000 | errno);
  };
  load(4);
  emit(0x15, 1, 0, 0xc000003e);
  ret(0x80000000);
  load(0);
  emit(0x35, 0, 1, 0x40000000);
  ret(0x00050001);
  emit(0x15, 0, 4, 56); // clone(flags, ...)
  load(16);
  emit(0x45, 0, 1, 0x7e020000);
  ret(0x00050001);
  ret(0x7fff0000);
  // Privileged namespace, mount, kernel, keyring and cross-process operations.
  for (const syscall of [
    101, 155, 165, 166, 175, 176, 246, 248, 249, 250, 272, 298, 308, 310, 311,
    313, 321, 323, 428, 429, 430, 431, 432, 438, 442,
  ])
    deny(syscall);
  deny(435, 38); // clone3 -> ENOSYS, not an unfiltered namespace-creation route.
  ret(0x7fff0000);
  const program = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    program.writeUInt16LE(code, index * 8);
    program[index * 8 + 2] = jt;
    program[index * 8 + 3] = jf;
    program.writeUInt32LE(k >>> 0, index * 8 + 4);
  });
  return program;
}
