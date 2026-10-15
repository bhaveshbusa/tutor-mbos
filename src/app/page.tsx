export default function HomePage() {
  return (
    <main>
      <h1>Tutor MBOS</h1>
      <p>
        Sign in to administer one tutoring business. Each account owns one
        business.
      </p>
      <p>
        <a href="/login">Sign in</a>
        {" · "}
        <a href="/onboarding">Create your business</a>
        {" · "}
        <a href="/business">Your business</a>
      </p>
    </main>
  );
}
