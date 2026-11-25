import Link from "next/link";

export default function CadastroPage() {
  return (
    <main style={{
      minHeight: "100vh", display: "grid", placeItems: "center", padding: 20,
      background: "#06140c", color: "#fff", fontFamily: "sans-serif",
    }}>
      <section style={{
        width: "min(440px,100%)", border: "1px solid rgba(231,179,78,.22)",
        padding: 30, borderRadius: 20, background: "rgba(11,31,20,.94)",
      }}>
        <div style={{color:"#e7b34e",fontWeight:800,letterSpacing:".14em"}}>UAI DISPAROS</div>
        <h1>Solicitar acesso</h1>
        <p style={{lineHeight:1.6,color:"rgba(255,255,255,.78)"}}>
          Durante a migração para o PostgreSQL, novos acessos são criados
          diretamente pelo administrador da operação. Contate o responsável
          para cadastrar sua conta ou redefinir a senha.
        </p>
        <Link href="/login" style={{color:"#e7b34e",fontWeight:700}}>
          Voltar ao login
        </Link>
      </section>
    </main>
  );
}
