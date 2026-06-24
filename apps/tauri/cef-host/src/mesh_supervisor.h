// mesh_supervisor.h — auto-spawn + supervise the always-on mesh node so the planetary content network is live
// with ZERO user input. Call once at boot. If the sidecar binary is absent, the mesh simply stays dormant and
// the browser still works (origin floor) — never a hard dependency.
#ifndef HOLO_MESH_SUPERVISOR_H
#define HOLO_MESH_SUPERVISOR_H

void StartMeshSupervisor();

#endif  // HOLO_MESH_SUPERVISOR_H
