import { Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <Routes>
      <Route path="*" element={<main style={{ padding: 32 }}><h1>Huddle</h1><p className="muted">Scaffold running.</p></main>} />
    </Routes>
  );
}
