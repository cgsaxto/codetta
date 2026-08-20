package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"codetta.dev/api/internal/features"
	"codetta.dev/api/internal/github"
)

/*
The endpoint behind "type your username".

It answers a question and does not act on it: given a login, here is the repository we would
play and the face to put on the card. Fetching and parsing that repository is the other
endpoint's job, and keeping the two apart is what lets the page say "torvalds → linux" while
the reading is still going on. One combined call would have to stay silent for the fifteen
seconds a large repository takes, which is exactly the moment a visitor needs to be told that
the thing they typed was understood.
*/

// topRepoCandidates is how deep the search goes before giving up on finding one we can read.
//
// Thirty rather than one, because a visitor's most-starred repository and their most-starred
// repository in a language this service parses are often not the same, and the second is the
// one they were asking for. Thirty rather than three hundred, because past the top thirty of
// anybody's account the star counts are noise and the answer stops being interesting.
const topRepoCandidates = 30

// userBudget is smaller than the repository budget on purpose. This is two JSON calls and a
// thumbnail; nothing here can legitimately take twenty-five seconds.
const userBudget = 10 * time.Second

type userRepoBody struct {
	Owner           string `json:"owner"`
	Name            string `json:"name"`
	Stars           int    `json:"stars"`
	PrimaryLanguage string `json:"primaryLanguage"`
}

type userBody struct {
	Login string `json:"login"`
	Name  string `json:"name"`
	// Avatar is a data URI, or absent. See github.User — inlined so the browser still never
	// talks to GitHub, and so the card can be drawn to a canvas and saved.
	Avatar string       `json:"avatar,omitempty"`
	Repo   userRepoBody `json:"repo"`
	// Passed over is how many more-starred repositories were skipped for their language. The
	// page says so out loud: "your most-starred repository" and "your most-starred repository
	// Codetta can read" are different claims, and only the second one is true.
	PassedOver int `json:"passedOver"`
}

func (deps Deps) userHandler(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), userBudget)
	defer cancel()

	login := r.PathValue("login")
	started := time.Now()

	user, err := deps.GitHub.User(ctx, login)
	if err != nil {
		if errors.Is(err, github.ErrNotFound) {
			// Not the repository sentence: a person who mistyped their own username needs to
			// be told that, not told about private repositories.
			writeError(w, http.StatusNotFound,
				"no GitHub account called "+login+". Codetta reads public accounts only.")
			return
		}
		deps.failUpstream(w, "looking up "+login, login, err)
		return
	}

	candidates, err := deps.GitHub.TopRepos(ctx, user, topRepoCandidates)
	if err != nil {
		deps.failUpstream(w, "listing repositories for "+user.Login, user.Login, err)
		return
	}
	if len(candidates) == 0 {
		writeError(w, http.StatusNotFound,
			user.Login+" has no public repositories that are not forks. Try another name, or "+
				"paste an owner/repo instead.")
		return
	}

	chosen, err := features.ChooseRepo(candidates)
	if err != nil {
		// The same 422 a repository in an unreadable language gets, because it is the same
		// answer: nothing here is in a language we parse.
		writeError(w, http.StatusUnprocessableEntity,
			"none of "+user.Login+"'s public repositories are in a language Codetta reads. "+
				"Supported: "+features.SupportedLanguages()+". Paste an owner/repo to play "+
				"something else.")
		return
	}

	passedOver := 0
	for _, candidate := range candidates {
		if candidate.Owner == chosen.Owner && candidate.Name == chosen.Name {
			break
		}
		passedOver++
	}

	deps.Logger.Info("picked a repository",
		"login", user.Login, "repo", chosen.Owner+"/"+chosen.Name,
		"stars", chosen.Stars, "passedOver", passedOver, "took", time.Since(started))

	writeJSON(w, http.StatusOK, userBody{
		Login:  user.Login,
		Name:   user.Name,
		Avatar: user.Avatar,
		Repo: userRepoBody{
			Owner:           chosen.Owner,
			Name:            chosen.Name,
			Stars:           chosen.Stars,
			PrimaryLanguage: chosen.PrimaryLanguage,
		},
		PassedOver: passedOver,
	})
}
