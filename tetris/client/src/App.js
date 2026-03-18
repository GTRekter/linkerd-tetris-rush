import React, { Component } from 'react';
import { Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import PlayerPage from './pages/PlayerPage';

export default class App extends Component {
    render () {
        return (
            <Layout>
                <Route exact path='' component={PlayerPage} />
            </Layout>
        );
    }
}
