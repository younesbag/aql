import { redirect } from "next/navigation";

// الجذر يوجّه إلى الالتقاط (المستخدمون غير المسجّلين يحوّلهم proxy إلى /login).
export default function Home() {
  redirect("/capture");
}
