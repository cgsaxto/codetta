package site

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const index = `<!doctype html><html><head><title>Codetta</title>` +
	openTag +
	`<meta property="og:title" content="Codetta" />` +
	closeTag +
	`</head><body><div id="root"></div></body></html>`

func dist() fstest.MapFS {
	return fstest.MapFS{
		"index.html": {Data: []byte(index)},
		"og/manifest.json": {Data: []byte(`[
			{"owner":"psf","name":"requests","title":"psf/requests — Codetta",
			 "description":"Python, 9,841 lines.","image":"/og/psf-requests.png"}
		]`)},
		"og/psf-requests.png": {Data: []byte("png")},
	}
}

func serve(t *testing.T, files fs.FS, path string) *httptest.ResponseRecorder {
	t.Helper()

	handler, err := Handler(files)
	if err != nil {
		t.Fatalf("building the handler: %v", err)
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
}

func TestAPermalinkCarriesItsOwnCard(t *testing.T) {
	body := serve(t, dist(), "/r/psf/requests").Body.String()

	for _, want := range []string{"psf/requests — Codetta", "/og/psf-requests.png", "Python, 9,841 lines."} {
		if !strings.Contains(body, want) {
			t.Errorf("the unfurl is missing %q:\n%s", want, body)
		}
	}
	// The app still has to boot: the meta tags replace one block, not the document.
	if !strings.Contains(body, `<div id="root">`) {
		t.Errorf("the page lost its root element:\n%s", body)
	}
	if strings.Contains(body, openTag) {
		t.Errorf("the markers were served to the browser:\n%s", body)
	}
}

func TestCaseFoldsTheWayGitHubDoes(t *testing.T) {
	// github.com/PSF/Requests is the same repository. A link that unfurls differently
	// depending on how it was typed is a bug nobody would think to look for.
	body := serve(t, dist(), "/r/PSF/Requests").Body.String()

	if !strings.Contains(body, "/og/psf-requests.png") {
		t.Errorf("a differently-cased permalink lost its card:\n%s", body)
	}
}

func TestAnUnknownRepositoryStillGetsAPage(t *testing.T) {
	// Eight cards against every repository on GitHub: the fallback is the common path.
	body := serve(t, dist(), "/r/torvalds/linux").Body.String()

	if !strings.Contains(body, "/og/cover.png") {
		t.Errorf("an unknown repository did not fall back to the cover:\n%s", body)
	}
	if !strings.Contains(body, `<div id="root">`) {
		t.Errorf("an unknown repository was not served the app:\n%s", body)
	}
}

func TestStaticFilesAreServedUntouched(t *testing.T) {
	recorder := serve(t, dist(), "/og/psf-requests.png")

	if got := recorder.Body.String(); got != "png" {
		t.Errorf("the image was rewritten: %q", got)
	}
}

func TestOnlyTwoSegmentsAreAPermalink(t *testing.T) {
	// /r/owner/name/anything is not a page this app has. It must reach the file server and
	// 404 there, rather than being answered with a card for a repository called "name".
	if code := serve(t, dist(), "/r/psf/requests/extra").Code; code != http.StatusNotFound {
		t.Errorf("a deeper path was treated as a permalink: %d", code)
	}
	if code := serve(t, dist(), "/r/psf").Code; code != http.StatusNotFound {
		t.Errorf("an owner alone was treated as a permalink: %d", code)
	}
}

func TestABrokenBuildFailsAtStartup(t *testing.T) {
	// Both of these produce a page that looks correct in a browser and unfurls as nothing.
	// Startup is the only moment anyone is watching.
	t.Run("no manifest", func(t *testing.T) {
		files := dist()
		delete(files, "og/manifest.json")
		if _, err := Handler(files); err == nil {
			t.Error("a build with no manifest was accepted")
		}
	})

	t.Run("no marker", func(t *testing.T) {
		files := dist()
		files["index.html"] = &fstest.MapFile{Data: []byte(`<!doctype html><html></html>`)}
		if _, err := Handler(files); err == nil {
			t.Error("an index with nothing to replace was accepted")
		}
	})
}
