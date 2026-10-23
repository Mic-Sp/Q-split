from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import time

from qiskit import QuantumCircuit, transpile
from qiskit.circuit import Parameter
from qiskit_aer import AerSimulator
from qiskit_aer.noise import NoiseModel, depolarizing_error, thermal_relaxation_error

app = FastAPI(title="Q-Split Systems Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class CircuitRequest(BaseModel):
    n_qubits: int = 2
    theta: float = 0.785
    t1_us: float = 50.0
    t2_us: float = 30.0
    gate_error_rate: float = 0.01
    classical_bus_latency_ms: float = 12.0

@app.get("/health")
def health_check():
    return {"status": "online", "engine": "Qiskit Aer"}

@app.post("/api/simulate")
def simulate_hybrid_layer(req: CircuitRequest):
    t_start = time.perf_counter()
    
    qc = QuantumCircuit(req.n_qubits, req.n_qubits)
    param = Parameter('θ')
    
    for i in range(req.n_qubits):
        qc.ry(param, i)
    if req.n_qubits > 1:
        for i in range(req.n_qubits - 1):
            qc.cx(i, i + 1)
    qc.measure(range(req.n_qubits), range(req.n_qubits))
    
    bound_circuit = qc.assign_parameters({param: req.theta})
    
    noise_model = NoiseModel()
    if req.gate_error_rate > 0:
        error_1q = depolarizing_error(req.gate_error_rate, 1)
        noise_model.add_all_qubit_quantum_error(error_1q, ['ry'])
        if req.n_qubits > 1:
            error_2q = depolarizing_error(min(req.gate_error_rate * 3, 0.5), 2)
            noise_model.add_all_qubit_quantum_error(error_2q, ['cx'])
            
    t1_ns = max(req.t1_us, 0.1) * 1000
    t2_ns = max(min(req.t2_us, 2 * req.t1_us), 0.1) * 1000
    relax_1q = thermal_relaxation_error(t1_ns, t2_ns, 50)
    noise_model.add_all_qubit_quantum_error(relax_1q, ['ry'])
    
    sim = AerSimulator(noise_model=noise_model)
    transpiled = transpile(bound_circuit, sim)
    job = sim.run(transpiled, shots=1024)
    counts = job.result().get_counts()
    
    compute_time_ms = (time.perf_counter() - t_start) * 1000
    total_latency_ms = compute_time_ms + req.classical_bus_latency_ms
    
    ideal_dominant_state = format(0, f'0{req.n_qubits}b')
    dominant_count = counts.get(ideal_dominant_state, 0)
    fidelity_proxy = round(dominant_count / 1024.0, 4)
    
    return {
        "counts": counts,
        "fidelity_proxy": fidelity_proxy,
        "compute_time_ms": round(compute_time_ms, 2),
        "bus_latency_ms": req.classical_bus_latency_ms,
        "total_latency_ms": round(total_latency_ms, 2),
        "coherence_budget_status": "Exceeded" if req.t2_us < 15.0 else "Nominal"
    }