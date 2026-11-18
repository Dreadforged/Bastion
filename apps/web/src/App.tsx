import { Permission } from "@bastion/shared";

export function App() {
  return (
    <main>
      <h1>Bastion</h1>
      <p>Privacy-first chat and community. Scaffold only.</p>
      <p>{Object.keys(Permission).length} permission flags loaded from @bastion/shared.</p>
    </main>
  );
}
