/** @jsxImportSource @/server/report/jsx */
import { describe, expect, it } from "vitest";
import { Fragment } from "./jsx-runtime";

describe("string JSX runtime", () => {
  it("escapes text and attributes, keeps raw markup only when asked", () => {
    const evil = `<script>alert("x")</script>&'`;
    const html = String(
      <div className="a" title={evil} style={{ fontSize: "8pt", width: "50%" }}>
        {evil}
        <style dangerouslySetInnerHTML={{ __html: "b{color:red}" }} />
        <meta charSet="utf-8" />
        {null}
        {false}
        {[1, 2]}
        <Fragment>
          <i>ok</i>
        </Fragment>
      </div>,
    );
    expect(html).toBe(
      '<div class="a" title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#x27;" style="font-size:8pt;width:50%">' +
        "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#x27;<style>b{color:red}</style><meta charset=\"utf-8\"/>12<i>ok</i></div>",
    );
  });

  it("renders function components", () => {
    const Tag = ({ kind, children }: { kind: string; children: string }) => <span className={`tag ${kind}`}>{children}</span>;
    expect(String(<Tag kind="P1">P1</Tag>)).toBe('<span class="tag P1">P1</span>');
  });
});
